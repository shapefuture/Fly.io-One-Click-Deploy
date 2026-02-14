import express from 'express';
import { execa } from 'execa';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from 'openai';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Environment Detection
const IS_VERCEL = process.env.VERCEL === '1';

// On Vercel, we must use /tmp. Locally, we use a local folder.
const BASE_WORK_DIR = IS_VERCEL ? os.tmpdir() : __dirname;
const TEMP_DIR = path.join(BASE_WORK_DIR, 'fly_deployer_workspaces');
const FLY_INSTALL_DIR = path.join(BASE_WORK_DIR, '.fly');
const FLY_BIN = path.join(FLY_INSTALL_DIR, 'bin', 'flyctl');

app.use(cors());
app.use(express.json());

// --- Initialization & Cleanup ---

async function ensureTempDir() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (e) {
        console.error("Failed to create temp dir:", e);
    }
}

// Just-In-Time Installer for Flyctl on Serverless
async function ensureFlyCtl() {
    // 1. Check if global flyctl exists (Development / Docker)
    try {
        await execa('flyctl', ['version']);
        return 'flyctl'; // Global command
    } catch (e) {
        // Global not found, check local /tmp install
    }

    // 2. Check if we already installed it in /tmp
    try {
        await fs.access(FLY_BIN);
        return FLY_BIN;
    } catch (e) {
        // Not installed, install it now
    }

    console.log("Installing flyctl to", FLY_INSTALL_DIR);
    try {
        // Download install script
        const installScriptPath = path.join(BASE_WORK_DIR, 'install-fly.sh');
        
        // We use fetch (Node 18+) to get the script
        const response = await fetch('https://fly.io/install.sh');
        if (!response.ok) throw new Error('Failed to download fly install script');
        
        await fs.writeFile(installScriptPath, await response.text());
        await fs.chmod(installScriptPath, 0o755);

        // Run install script with custom install path
        await execa('sh', [installScriptPath], {
            env: { ...process.env, FLYCTL_INSTALL: FLY_INSTALL_DIR }
        });

        return FLY_BIN;
    } catch (error) {
        console.error("Failed to install flyctl:", error);
        throw new Error("Could not install flyctl runtime dependency");
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

async function downloadRepo(repoUrl, targetDir, githubToken) {
    // 1. Construct Archive URL
    // Remove .git suffix if present
    const cleanUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
    // Use HEAD to get the default branch
    const archiveUrl = `${cleanUrl}/archive/HEAD.zip`;

    console.log(`Downloading repo from ${archiveUrl}...`);
    
    const headers = {};
    if (githubToken) {
        headers['Authorization'] = `token ${githubToken}`;
        headers['User-Agent'] = 'Universal-Fly-Deployer';
    }

    const response = await fetch(archiveUrl, { headers });
    if (!response.ok) {
        throw new Error(`Failed to download repository: ${response.status} ${response.statusText}. ${githubToken ? 'Token provided.' : 'No token.'}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // 2. Extract Zip
    const zip = new AdmZip(buffer);
    zip.extractAllTo(targetDir, true);
    
    // 3. Find root folder
    // GitHub zips usually extract to a single top-level folder (e.g. repo-main)
    const entries = await fs.readdir(targetDir);
    const realEntries = entries.filter(e => !e.startsWith('.')); // Ignore hidden files like .DS_Store
    
    if (realEntries.length === 1) {
        const internalPath = path.join(targetDir, realEntries[0]);
        const stats = await fs.stat(internalPath);
        if (stats.isDirectory()) {
            return internalPath;
        }
    }
    
    return targetDir;
}

// --- Helper Functions ---

async function runFlyctl(args, token, cwd, env = {}) {
    try {
        const exe = await ensureFlyCtl();
        
        // If using custom binary, ensure its dir is in PATH for internal calls
        const localPath = path.dirname(exe);
        const newPath = `${localPath}:${process.env.PATH}`;

        const { stdout, stderr } = await execa(exe, args, {
            cwd,
            env: { 
                ...process.env, 
                FLY_API_TOKEN: token, 
                NO_COLOR: "1", 
                PATH: newPath,
                ...env 
            },
            timeout: 600000 // 10 minutes (Note: Vercel Free tier limits function duration to 10s-60s)
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
            content += `\n--- ${file} ---\n${data.slice(0, 8000)}\n`; 
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

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        environment: IS_VERCEL ? 'vercel' : 'standard',
        tempDir: TEMP_DIR
    });
});

app.post('/api/analyze', async (req, res) => {
    const { repoUrl, aiConfig, githubToken, preferExistingConfig } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'Repo URL is required' });

    await ensureTempDir();
    const sessionId = uuidv4();
    const workDir = path.join(TEMP_DIR, sessionId);

    try {
        await fs.mkdir(workDir, { recursive: true });
        
        let fileStructure = [];
        let configContent = "";
        let analysisMethod = "local";

        // --- SHORT CIRCUIT: Trust User ---
        // If user says "Prefer Existing Config", we skip analysis entirely.
        // We do not download the repo here to save time and bandwidth.
        if (preferExistingConfig) {
            console.log(`[${sessionId}] Prefer existing config enabled. Skipping download and AI analysis.`);
            return res.json({
                success: true,
                sessionId,
                fly_toml: "# Using existing configuration from repository",
                dockerfile: null,
                explanation: "Skipping analysis. Deployment will use the 'fly.toml' and 'Dockerfile' found in the repository directly.",
                envVars: {},
                stack: "Repository Config",
                healthCheckPath: "",
                sources: [],
                warnings: ["Analysis skipped. Using repository configuration."]
            });
        }

        try {
            // Try downloading repo
            const repoDir = await downloadRepo(repoUrl, workDir, githubToken);
            fileStructure = await scanRepoStructure(repoDir);
            configContent = await readConfigFiles(repoDir);
        } catch (e) {
            console.warn(`[${sessionId}] Repo download failed: ${e.message}. Falling back to AI Search.`);
            analysisMethod = "search_fallback";
        }

        const prompt = `
        You are a Lead DevOps Architect. Analyze this repository to generate a deployment configuration for Fly.io.

        Context:
        - The user wants to deploy this application to Fly.io.
        - Repository URL: ${repoUrl}
        - Analysis Method: ${analysisMethod === 'local' ? 'Codebase Analysis' : 'Search & Inference (Codebase unavailable)'}

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
           - **IMPORTANT SYNTAX RULES**:
             - Do NOT use an [app] block. 'app' and 'primary_region' must be top-level keys.
             - Prefer using [http_service] for web applications.
             - If using [[services]], ensure port 80 has 'handlers = ["http"]' (to force redirect) and port 443 has 'handlers = ["tls", "http"]'. 
             - Only use 'handlers = ["tls"]' if the application expects raw TCP traffic (e.g., specific proxies).
           - Set 'auto_stop_machines = true' and 'auto_start_machines = true'.
           - **COST EFFICIENCY**: Include a [[vm]] block with 'cpu_kind = "shared"', 'cpus = 1', and 'memory_mb = 256' to target the free/hobby tier.
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
        let warnings = [];

        if (provider === 'openrouter') {
            console.log(`[${sessionId}] Using OpenRouter with model ${aiConfig.model}`);
            
            if (analysisMethod === 'search_fallback') {
                warnings.push("Analysis is based on limited information because repository download failed and Search is unavailable on OpenRouter.");
            }

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

            if (!apiKey) {
                throw new Error("Gemini API Key is missing. Please provide it in AI Settings or ensure the server has a default key.");
            }

            console.log(`[${sessionId}] Using Gemini with model ${aiConfig?.model || 'default'}`);
            
            const ai = new GoogleGenAI({ apiKey });
            
            const tools = [];
            if (analysisMethod === 'search_fallback') {
                tools.push({ googleSearch: {} });
                warnings.push("Codebase download failed. Analysis based on AI search inference.");
            }
            
            const response = await ai.models.generateContent({
                model: aiConfig?.model || 'gemini-3-flash-preview',
                contents: prompt,
                config: {
                    tools: tools,
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
            sources,
            warnings
        });

    } catch (error) {
        console.error(`Analysis failed for ${repoUrl}:`, error);
        await cleanup(workDir);
        res.status(500).json({ error: error.message || "Failed to analyze repository" });
    }
});

app.post('/api/deploy', async (req, res) => {
    const { sessionId, flyToken, flyToml, dockerfile, appName, region, repoUrl, githubToken, preferExistingConfig } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = (msg, type = 'info') => {
        res.write(`data: ${JSON.stringify({ message: msg, type })}\n\n`);
    };

    await ensureTempDir();
    const workDir = path.join(TEMP_DIR, sessionId);
    let targetDir = workDir;

    try {
        // Recover context or download fresh if analyzing was skipped or files missing
        let needsDownload = true;
        try {
             await fs.access(workDir);
             const files = await fs.readdir(workDir);
             if (files.length > 0) {
                 const realEntries = files.filter(e => !e.startsWith('.'));
                 if (realEntries.length === 1 && (await fs.stat(path.join(workDir, realEntries[0]))).isDirectory()) {
                     targetDir = path.join(workDir, realEntries[0]);
                 }
                 needsDownload = false;
             }
        } catch {
             await fs.mkdir(workDir, { recursive: true });
        }

        if (needsDownload) {
             if (repoUrl) {
                stream("Initializing build context...", "info");
                try {
                    targetDir = await downloadRepo(repoUrl, workDir, githubToken);
                } catch (e) {
                    throw new Error(`Failed to download repository context: ${e.message}`);
                }
             } else {
                 stream("Warning: Repository context missing and no URL provided.", "warning");
             }
        }

        stream("Configuring deployment...", "info");

        // 1. Write Config Files
        const tomlPath = path.join(targetDir, 'fly.toml');
        
        if (preferExistingConfig) {
            try {
                // If user preferred existing config, we must find it here
                await fs.access(tomlPath);
                stream("Found existing fly.toml in repository.", "success");
                
                // We MUST patch the app name and region, otherwise flyctl won't know where to deploy the new app
                let existingToml = await fs.readFile(tomlPath, 'utf8');
                
                // Strip existing headers to avoid conflict
                existingToml = existingToml.replace(/^\[app\]\s*$/gm, '');
                existingToml = existingToml.replace(/^(app|name)\s*=.*/gm, '');
                existingToml = existingToml.replace(/^primary_region\s*=.*/gm, '');
                
                const header = `app = "${appName}"\nprimary_region = "${region}"\n`;
                await fs.writeFile(tomlPath, header + existingToml.trim());
                stream(`Patched fly.toml with app="${appName}" and region="${region}"`, "info");
            } catch (e) {
                throw new Error("You selected 'Prefer existing config', but 'fly.toml' was not found in the repository.");
            }
        } else {
            // Standard Path: Write config from inputs
            let finalToml = flyToml;
            finalToml = finalToml.replace(/^\[app\]\s*$/gm, '');
            finalToml = finalToml.replace(/^(app|name)\s*=.*/gm, '');
            finalToml = finalToml.replace(/^primary_region\s*=.*/gm, '');
            
            const header = `app = "${appName}"\nprimary_region = "${region}"\n`;
            finalToml = header + finalToml.trim();

            await fs.writeFile(tomlPath, finalToml);
            
            if (dockerfile) {
                await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerfile);
                stream("Using AI-generated Dockerfile", "info");
            } else {
                stream("Using repository Dockerfile", "info");
            }
        }

        // 2. Create/Check App
        const flyExe = await ensureFlyCtl();
        const localPath = path.dirname(flyExe);
        const envPath = `${localPath}:${process.env.PATH}`;
        
        stream(`Registering app '${appName}' in region '${region}'...`, "info");
        try {
            await runFlyctl(['apps', 'create', appName, '--org', 'personal'], flyToken, targetDir);
            stream(`App '${appName}' created successfully.`, "success");
        } catch (e) {
            if (e && e.message && e.message.includes('taken')) {
                stream(`App '${appName}' already exists. Updating...`, "warning");
            } else {
                throw e;
            }
        }

        // 3. Deploy
        stream("Starting remote builder...", "log");
        stream("This may take a few minutes. Streaming logs...", "log");

        const deployArgs = ['deploy', '--ha=false']; 
        
        const deployProcess = execa(flyExe, deployArgs, {
            cwd: targetDir,
            env: { 
                ...process.env, 
                FLY_API_TOKEN: flyToken, 
                NO_COLOR: "1", 
                PATH: envPath 
            },
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
        const statusCheck = await runFlyctl(['status', '--json'], flyToken, targetDir);
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

if (process.env.NODE_ENV === 'production' && !IS_VERCEL) {
    app.use(express.static(path.join(__dirname, '../dist')));
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));
}

if (!IS_VERCEL) {
    app.listen(port, '0.0.0.0', () => console.log(`🚀 Backend running on port ${port}`));
}

export default app;