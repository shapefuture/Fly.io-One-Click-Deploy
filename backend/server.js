import express from 'express';
import { execa } from 'execa';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from 'openai';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
let tar;
try {
    tar = require('tar');
} catch (e) {
    console.warn("⚠️ Warning: 'tar' npm package is missing. Fallback to system tar will be used.");
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Environment Detection
const IS_VERCEL = process.env.VERCEL === '1';
const BASE_WORK_DIR = IS_VERCEL ? os.tmpdir() : __dirname;
const TEMP_DIR = path.join(BASE_WORK_DIR, 'fly_deployer_workspaces');
const FLY_INSTALL_DIR = path.join(BASE_WORK_DIR, '.fly');
const FLY_BIN = path.join(FLY_INSTALL_DIR, 'bin', 'flyctl');

app.use(cors());
app.use(express.json());

// --- Initialization & Self-Healing ---

async function ensureTempDir() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
        // Clean up old workspaces if not on Vercel (Vercel cleans /tmp automatically)
        if (!IS_VERCEL) {
            const files = await fs.readdir(TEMP_DIR);
            const now = Date.now();
            for (const file of files) {
                const filePath = path.join(TEMP_DIR, file);
                const stats = await fs.stat(filePath);
                if (now - stats.mtimeMs > 3600000) { // 1 hour old
                    await fs.rm(filePath, { recursive: true, force: true }).catch(() => {});
                }
            }
        }
    } catch (e) {
        if (e.code !== 'EEXIST') console.error("Initialization Error:", e);
    }
}

// Ensure temp dir exists on startup
ensureTempDir();

/**
 * Self-healing binary management.
 * Tries global, then local, then installs if broken.
 */
async function ensureFlyCtl() {
    const verify = async (p) => {
        try {
            const { stdout } = await execa(p, ['version'], { timeout: 5000 });
            return stdout.includes('flyctl v');
        } catch (e) { return false; }
    };

    // 1. Try Global
    if (await verify('flyctl')) return 'flyctl';

    // 2. Try Local if exists
    if (existsSync(FLY_BIN) && await verify(FLY_BIN)) return FLY_BIN;

    // 3. Re-install if corrupted or missing
    console.log("Antifragile Action: Installing/Repairing flyctl...");
    try {
        const platform = os.platform();
        const arch = os.arch();
        let osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
        let archName = arch === 'arm64' ? 'arm64' : 'x86_64';
        
        const releaseRes = await fetch('https://api.github.com/repos/superfly/flyctl/releases/latest');
        if (!releaseRes.ok) throw new Error("GitHub API Unreachable");
        const releaseData = await releaseRes.json();
        const version = releaseData.tag_name.replace(/^v/, '');
        
        const assetName = `flyctl_${version}_${osName}_${archName}.tar.gz`;
        const downloadUrl = `https://github.com/superfly/flyctl/releases/download/v${version}/${assetName}`;
        
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        
        const tgzPath = path.join(BASE_WORK_DIR, `flyctl_repair_${uuidv4()}.tar.gz`);
        await fs.writeFile(tgzPath, Buffer.from(await response.arrayBuffer()));
        
        const binDir = path.dirname(FLY_BIN);
        await fs.mkdir(binDir, { recursive: true });
        
        if (tar) {
            await tar.x({ file: tgzPath, cwd: binDir }).catch(() => execa('tar', ['-xzf', tgzPath, '-C', binDir]));
        } else {
            await execa('tar', ['-xzf', tgzPath, '-C', binDir]);
        }
        
        await fs.unlink(tgzPath).catch(() => {});
        if (await verify(FLY_BIN)) return FLY_BIN;
        throw new Error("Installation failed verification");
    } catch (error) {
        throw new Error(`Flyctl Recovery Failed: ${error.message}`);
    }
}

async function cleanup(dirPath) {
    if (!dirPath || !dirPath.startsWith(TEMP_DIR)) return;
    await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
}

async function downloadRepo(repoUrl, targetDir, githubToken) {
    const cleanUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
    const archiveUrl = `${cleanUrl}/archive/HEAD.zip`;
    const headers = githubToken ? { 'Authorization': `token ${githubToken}`, 'User-Agent': 'Universal-Fly-Deployer' } : {};

    const response = await fetch(archiveUrl, { headers });
    if (!response.ok) throw new Error(`Repo Download Error: ${response.status}`);
    
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    zip.extractAllTo(targetDir, true);
    
    const entries = await fs.readdir(targetDir);
    const realEntries = entries.filter(e => !e.startsWith('.'));
    if (realEntries.length === 1) {
        const internalPath = path.join(targetDir, realEntries[0]);
        if ((await fs.stat(internalPath)).isDirectory()) return internalPath;
    }
    return targetDir;
}

// --- Analysis & Fallbacks ---

const GET_SAFE_FALLBACK_CONFIG = (repoUrl) => ({
    fly_toml: `app = "change-me"\nprimary_region = "iad"\n\n[http_service]\n  internal_port = 8080\n  force_https = true\n  auto_stop_machines = true\n  auto_start_machines = true\n\n[[vm]]\n  cpu_kind = "shared"\n  cpus = 1\n  memory_mb = 256`,
    dockerfile: `FROM node:alpine\nWORKDIR /app\nCOPY . .\nRUN npm install --production\nCMD ["npm", "start"]`,
    explanation: "⚠️ AI Analysis failed. Providing a safe-mode Node.js default configuration. Please review ports and start commands.",
    envVars: { "PORT": "Standard internal port" },
    stack: "Unknown (Fallback Mode)",
    healthCheckPath: "/"
});

// --- Routes ---

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), env: IS_VERCEL ? 'vercel' : 'node' });
});

app.post('/api/analyze', async (req, res) => {
    const { repoUrl, aiConfig, githubToken, preferExistingConfig } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'Repo URL is required' });

    const sessionId = uuidv4();
    const workDir = path.join(TEMP_DIR, sessionId);
    await fs.mkdir(workDir, { recursive: true }).catch(() => {});

    try {
        if (preferExistingConfig) {
            return res.json({
                success: true, sessionId,
                fly_toml: "# Using repo fly.toml",
                dockerfile: null,
                explanation: "Using existing configuration.",
                envVars: {}, stack: "Existing", healthCheckPath: ""
            });
        }

        let repoDir;
        try {
            repoDir = await downloadRepo(repoUrl, workDir, githubToken);
        } catch (e) {
            // If download fails, we can't do local analysis. 
            // Antifragile: Don't give up, try to infer purely from URL if Gemini Search is enabled.
            console.warn("Download failed, attempting pure inference...");
        }

        const configContent = repoDir ? await (async (dir) => {
            const files = ['package.json', 'requirements.txt', 'Dockerfile', 'fly.toml', 'go.mod', 'Cargo.toml', 'Gemfile'];
            let text = "";
            for (const f of files) {
                try {
                    const data = await fs.readFile(path.join(dir, f), 'utf8');
                    text += `\n--- ${f} ---\n${data.slice(0, 5000)}\n`;
                } catch {}
            }
            return text;
        })(repoDir) : "Codebase unavailable.";

        const prompt = `Lead DevOps Analysis: Repo ${repoUrl}. Configs: ${configContent}. Output JSON: {fly_toml, dockerfile, explanation, envVars:[{name, reason}], stack, healthCheckPath}. Syntax: No [app] block in toml. Use [http_service].`;

        try {
            const provider = aiConfig?.provider || 'gemini';
            let rawResult;
            
            if (provider === 'openrouter') {
                const openai = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: aiConfig.apiKey });
                const completion = await openai.chat.completions.create({
                    model: aiConfig.model || 'google/gemini-2.0-flash-exp:free',
                    messages: [{ role: 'system', content: 'JSON expert.' }, { role: 'user', content: prompt }],
                    response_format: { type: 'json_object' }
                });
                rawResult = JSON.parse(completion.choices[0].message.content.trim());
            } else {
                const apiKey = aiConfig?.apiKey || process.env.API_KEY;
                if (!apiKey) throw new Error("No API Key");
                const ai = new GoogleGenAI({ apiKey });
                const response = await ai.models.generateContent({
                    model: aiConfig?.model || 'gemini-3-flash-preview',
                    contents: prompt,
                    config: { responseMimeType: "application/json" }
                });
                rawResult = JSON.parse(response.text.trim());
            }

            const envVars = {};
            if (rawResult.envVars) rawResult.envVars.forEach(v => { if (v?.name) envVars[v.name] = v.reason; });
            res.json({ success: true, sessionId, ...rawResult, envVars });
        } catch (aiError) {
            console.error("AI Analysis Failed, using safe-mode fallback:", aiError);
            res.json({ success: true, sessionId, ...GET_SAFE_FALLBACK_CONFIG(repoUrl) });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/deploy', async (req, res) => {
    const { sessionId, flyToken, flyToml, dockerfile, appName, region, repoUrl, githubToken, preferExistingConfig } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = (msg, type = 'info') => {
        res.write(`data: ${JSON.stringify({ message: msg, type })}\n\n`);
    };

    const workDir = path.join(TEMP_DIR, sessionId);
    let targetDir = workDir;

    try {
        const flyExe = await ensureFlyCtl();
        const localPath = path.dirname(flyExe);
        const envPath = `${localPath}:${process.env.PATH}`;

        // Ensure Source is present
        try {
            await fs.access(workDir);
            const files = await fs.readdir(workDir);
            if (files.length > 0) {
                const realEntries = files.filter(e => !e.startsWith('.'));
                if (realEntries.length === 1 && (await fs.stat(path.join(workDir, realEntries[0]))).isDirectory()) targetDir = path.join(workDir, realEntries[0]);
            } else {
                stream("Context lost, re-downloading...", "warning");
                targetDir = await downloadRepo(repoUrl, workDir, githubToken);
            }
        } catch {
            await fs.mkdir(workDir, { recursive: true });
            targetDir = await downloadRepo(repoUrl, workDir, githubToken);
        }

        stream("Writing configurations...", "info");
        const tomlPath = path.join(targetDir, 'fly.toml');
        let tomlData = flyToml;
        if (preferExistingConfig) {
            tomlData = await fs.readFile(tomlPath, 'utf8');
        }
        // Patch toml with current inputs
        tomlData = `app = "${appName}"\nprimary_region = "${region}"\n` + tomlData.replace(/^app\s*=.*$/gm, '').replace(/^primary_region\s*=.*$/gm, '').replace(/^\[app\]\s*$/gm, '');
        await fs.writeFile(tomlPath, tomlData);
        if (dockerfile) await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerfile);

        stream(`Authenticating with Fly.io...`, "info");
        try {
            await execa(flyExe, ['apps', 'create', appName], { env: { FLY_API_TOKEN: flyToken, NO_COLOR: "1", PATH: envPath } });
            stream(`New app '${appName}' registered.`, "success");
        } catch (e) {
            if (e.stderr?.includes('taken') || e.stderr?.includes('exists')) stream("App already exists, performing update...", "warning");
            else throw e;
        }

        stream("Launching deployment (Remote Build)...", "log");
        const deploy = execa(flyExe, ['deploy', '--ha=false', '--wait-timeout', '600'], {
            cwd: targetDir,
            env: { ...process.env, FLY_API_TOKEN: flyToken, NO_COLOR: "1", PATH: envPath }
        });

        deploy.stdout.on('data', c => c.toString().split('\n').forEach(l => l.trim() && stream(l.trim(), 'log')));
        deploy.stderr.on('data', c => c.toString().split('\n').forEach(l => l.trim() && stream(l.trim(), 'log')));

        await deploy;
        
        const statusCheck = await execa(flyExe, ['status', '--json'], { env: { FLY_API_TOKEN: flyToken, PATH: envPath } });
        const status = JSON.parse(statusCheck.stdout);
        res.write(`data: ${JSON.stringify({ type: 'success', appUrl: `https://${status.Hostname}`, appName: status.Name })}\n\n`);

    } catch (error) {
        stream(`FATAL: ${error.message}`, 'error');
    } finally {
        await cleanup(workDir);
        res.end();
    }
});

if (process.env.NODE_ENV === 'production' && !IS_VERCEL) {
    app.use(express.static(path.join(__dirname, '../dist')));
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));
}

if (!IS_VERCEL) app.listen(port, '0.0.0.0', () => console.log(`🚀 Antifragile backend on port ${port}`));

export default app;