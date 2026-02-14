import express from 'express';
import { execa } from 'execa';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import simpleGit from 'simple-git';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from 'openai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const TEMP_DIR = path.join(__dirname, 'temp_workspaces');

// --- Initialization & Cleanup ---

async function ensureTempDir() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (e) {
        console.error("Failed to create temp dir:", e);
    }
}

async function checkFlyCtlInstalled() {
    try {
        await execa('flyctl', ['version']);
        console.log("✅ flyctl is installed and ready.");
    } catch (e) {
        console.error("❌ CRITICAL: flyctl is NOT installed or not in PATH.");
        console.error("Please install it: https://fly.io/docs/hands-on/install-flyctl/");
        // We don't exit process here to allow dev mode without it, but deploys will fail.
    }
}

async function cleanup(dirPath) {
    if (!dirPath) return;
    try {
        // Safety check to ensure we are deleting inside TEMP_DIR
        if (dirPath.startsWith(TEMP_DIR)) {
            await fs.rm(dirPath, { recursive: true, force: true });
        }
    } catch (e) {
        console.error(`Failed to cleanup ${dirPath}:`, e);
    }
}

// Graceful Shutdown
process.on('SIGINT', async () => {
    console.log('Cleaning up temp directories...');
    await cleanup(TEMP_DIR);
    process.exit(0);
});

(async () => {
    await ensureTempDir();
    await checkFlyCtlInstalled();
})();

// --- Helper Functions ---

async function runFlyctl(args, token, cwd, env = {}) {
    try {
        // Determine executable (flyctl or fly)
        const exe = 'flyctl'; 
        const { stdout, stderr } = await execa(exe, args, {
            cwd,
            env: { ...process.env, FLY_API_TOKEN: token, NO_COLOR: "1", ...env },
            timeout: 600000 // 10 minutes timeout for builds
        });
        return { success: true, stdout, stderr };
    } catch (error) {
        const errorMsg = error.stderr || error.stdout || error.message || 'Unknown flyctl error';
        throw new Error(errorMsg);
    }
}

async function scanRepoStructure(dir, depth = 0, maxDepth = 3) {
    if (depth > maxDepth) return [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        let files = [];
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue;
            
            if (entry.isDirectory()) {
                const subFiles = await scanRepoStructure(path.join(dir, entry.name), depth + 1, maxDepth);
                files = files.concat(subFiles.map(f => `${entry.name}/${f}`));
            } else {
                files.push(entry.name);
            }
        }
        return files;
    } catch (e) { return []; }
}

async function readConfigFiles(dir) {
    const criticalFiles = [
        'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
        'go.mod', 'go.sum',
        'requirements.txt', 'Pipfile', 'pyproject.toml',
        'Gemfile', 'Gemfile.lock',
        'composer.json', 'composer.lock',
        'Dockerfile', 'docker-compose.yml', 'Procfile',
        'mix.exs',
        'Cargo.toml',
        'deno.json',
        'next.config.js', 'remix.config.js', 'nuxt.config.ts', 'vite.config.ts', 'angular.json',
        'fly.toml', 'app.json'
    ];
    let content = "";
    for (const file of criticalFiles) {
        try {
            const filePath = path.join(dir, file);
            // Check if file exists first
            await fs.access(filePath);
            const data = await fs.readFile(filePath, 'utf8');
            content += `\n--- ${file} ---\n${data.slice(0, 8000)}\n`; // Increased context limit
        } catch (e) {}
    }
    return content;
}

// Clean markdown JSON if OpenRouter returns it
function cleanJson(text) {
    if (!text) return "";
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json/, '');
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```/, '');
    if (cleaned.endsWith('```')) cleaned = cleaned.replace(/```$/, '');
    return cleaned.trim();
}

// --- Routes ---

// Health Check Endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/analyze', async (req, res) => {
    const { repoUrl, aiConfig } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'Repo URL is required' });

    const sessionId = uuidv4();
    const workDir = path.join(TEMP_DIR, sessionId);

    try {
        await fs.mkdir(workDir, { recursive: true });
        const git = simpleGit();
        
        console.log(`[${sessionId}] Cloning ${repoUrl}...`);
        await git.clone(repoUrl, workDir, ['--depth', '1']);

        const fileStructure = await scanRepoStructure(workDir);
        const configContent = await readConfigFiles(workDir);

        const prompt = `
        You are a Lead DevOps Architect. Analyze this repository to generate a deployment configuration for Fly.io.

        Context:
        - The user wants to deploy this application to Fly.io.
        - We need a 'fly.toml' and potentially a 'Dockerfile'.
        
        Repository File Structure (truncated):
        ${fileStructure.slice(0, 100).join('\n')}
        ${fileStructure.length > 100 ? '... (more files)' : ''}

        Configuration Files Content:
        ${configContent}

        Tasks:
        1. **Stack Detection**: Identify language, framework, build tool, and package manager.
        2. **Port Strategy**: 
           - Detect the internal port (check 'scripts' in package.json, main files, or standard defaults). 
           - Note: Fly.io maps external 80/443 to this internal port.
        3. **Fly.toml Generation**:
           - Create a complete 'fly.toml'.
           - Use the [[services]] or [http_service] block.
           - Set 'auto_stop_machines = true' and 'auto_start_machines = true'.
           - Add a [checks] block for health monitoring if a health endpoint (/health, /up, /) is likely.
        4. **Dockerfile Generation**:
           - **Crucial**: If a 'Dockerfile' already exists in the provided config content, set the 'dockerfile' field in JSON to null. We prefer the user's Dockerfile.
           - If NO Dockerfile exists, generate a **production-grade Multi-Stage** Dockerfile.
           - For Node.js: Use 'node:alpine' or 'node:slim', build in one stage, copy to runner.
           - For Python: Use 'python:slim'.
           - Ensure 'CMD' or 'ENTRYPOINT' is correct based on 'package.json' scripts (e.g., 'npm start', 'npm run serve').
        5. **Environment Variables**: Identify *runtime* secrets (DB URLs, API Keys) needed.

        Output JSON strictly matching the schema.
        `;

        const provider = aiConfig?.provider || 'gemini';
        let rawResult;
        let sources = [];

        if (provider === 'openrouter') {
            console.log(`[${sessionId}] Using OpenRouter with model ${aiConfig.model}`);
            const openai = new OpenAI({
                baseURL: 'https://openrouter.ai/api/v1',
                apiKey: aiConfig.apiKey,
                defaultHeaders: {
                    'HTTP-Referer': 'https://universal-deployer.fly.dev',
                    'X-Title': 'Universal Fly Deployer',
                }
            });

            const completion = await openai.chat.completions.create({
                model: aiConfig.model || 'google/gemini-2.0-flash-exp:free',
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are a DevOps expert. You must output VALID JSON only. Do not output markdown code blocks. The JSON schema is: { fly_toml: string, dockerfile: string|null, explanation: string, envVars: [{name:string, reason:string}], stack: string, healthCheckPath: string }' 
                    },
                    { role: 'user', content: prompt }
                ],
                response_format: { type: 'json_object' }
            });

            const content = completion.choices[0].message.content;
            rawResult = JSON.parse(cleanJson(content));
        
        } else {
            // Default to Gemini
            const apiKey = aiConfig?.apiKey || process.env.API_KEY;
            console.log(`[${sessionId}] Using Gemini with model ${aiConfig?.model || 'default'}`);
            
            const ai = new GoogleGenAI({ apiKey });
            const response = await ai.models.generateContent({
                model: aiConfig?.model || 'gemini-3-flash-preview',
                contents: prompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            fly_toml: { type: Type.STRING },
                            dockerfile: { type: Type.STRING, nullable: true },
                            explanation: { type: Type.STRING },
                            envVars: { 
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        name: { type: Type.STRING },
                                        reason: { type: Type.STRING }
                                    },
                                    required: ["name", "reason"]
                                }
                            },
                            stack: { type: Type.STRING },
                            healthCheckPath: { type: Type.STRING }
                        },
                        required: ["fly_toml", "explanation", "envVars", "stack"]
                    }
                }
            });

            rawResult = JSON.parse(response.text.trim());
            
            sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map(chunk => {
                if (chunk.web) return { title: chunk.web.title, uri: chunk.web.uri };
                return null;
            }).filter(Boolean) || [];
        }

        // Transform envVars to object for frontend
        const envVars = {};
        if (Array.isArray(rawResult.envVars)) {
            rawResult.envVars.forEach(v => {
                if (v && v.name) envVars[v.name] = v.reason || '';
            });
        }

        res.json({ 
            success: true, 
            sessionId, 
            ...rawResult, 
            envVars,
            sources 
        });

    } catch (error) {
        console.error(`Analysis failed for ${repoUrl}:`, error);
        await cleanup(workDir);
        res.status(500).json({ error: error.message || "Failed to analyze repository" });
    }
});

app.post('/api/deploy', async (req, res) => {
    const { sessionId, flyToken, flyToml, dockerfile, appName, region } = req.body;

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = (msg, type = 'info') => {
        res.write(`data: ${JSON.stringify({ message: msg, type })}\n\n`);
    };

    const workDir = path.join(TEMP_DIR, sessionId);

    try {
        await fs.access(workDir);
        stream("Initializing build environment...", "info");

        // 1. Write Config Files
        const tomlPath = path.join(workDir, 'fly.toml');
        
        // Force sync app name and region in TOML
        let finalToml = flyToml;
        
        // Remove existing app/region keys to avoid duplicates
        finalToml = finalToml.replace(/^app\s*=.*$/m, '');
        finalToml = finalToml.replace(/^primary_region\s*=.*$/m, '');
        
        // Prepend correct values
        const header = `app = "${appName}"\nprimary_region = "${region}"\n`;
        finalToml = header + finalToml;

        await fs.writeFile(tomlPath, finalToml);
        if (dockerfile) {
            await fs.writeFile(path.join(workDir, 'Dockerfile'), dockerfile);
            stream("Using AI-generated Dockerfile", "info");
        } else {
            stream("Using repository Dockerfile", "info");
        }

        // 2. Create/Check App
        stream(`Registering app '${appName}' in region '${region}'...`, "info");
        try {
            await runFlyctl(['apps', 'create', appName, '--org', 'personal'], flyToken, workDir);
            stream(`App '${appName}' created successfully.`, "success");
        } catch (e) {
            if (e.message.includes('taken')) {
                stream(`App '${appName}' already exists. Updating...`, "warning");
            } else {
                throw e;
            }
        }

        // 3. Deploy
        stream("Starting remote builder...", "log");
        stream("This may take a few minutes. Streaming logs...", "log");

        const deployArgs = ['deploy', '--ha=false']; // High availability off for free tier speed
        
        const deployProcess = execa('flyctl', deployArgs, {
            cwd: workDir,
            env: { ...process.env, FLY_API_TOKEN: flyToken, NO_COLOR: "1" },
            all: true
        });

        deployProcess.all.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed) stream(trimmed, "log");
            });
        });

        await deployProcess;

        // 4. Verify
        stream("Verifying deployment status...", "info");
        const statusCheck = await runFlyctl(['status', '--json'], flyToken, workDir);
        const statusData = JSON.parse(statusCheck.stdout);

        res.write(`data: ${JSON.stringify({ 
            type: 'success', 
            appUrl: `https://${statusData.Hostname}`, 
            appName: statusData.Name 
        })}\n\n`);

    } catch (error) {
        console.error("Deploy error:", error);
        stream(`Deployment Failed: ${error.message}`, 'error');
    } finally {
        await cleanup(workDir);
        res.end();
    }
});

if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../dist')));
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));
}

app.listen(port, '0.0.0.0', () => console.log(`🚀 Backend running on port ${port}`));