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
import { pipeline } from 'stream/promises';

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

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION:', reason);
});

// --- ENVIRONMENT DETECTION ---
const IS_VERCEL = process.env.VERCEL === '1' || !!process.env.NOW_REGION || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const IS_WINDOWS = os.platform() === 'win32';
const BIN_NAME = IS_WINDOWS ? 'flyctl.exe' : 'flyctl';

// --- PATH CONFIGURATION ---
const BASE_WORK_DIR = IS_VERCEL ? os.tmpdir() : __dirname;
const VERCEL_HOME = path.join(os.tmpdir(), 'fly_home');
const TEMP_DIR = path.join(BASE_WORK_DIR, 'fly_deployer_workspaces');
const FLY_INSTALL_DIR = path.join(VERCEL_HOME, '.fly');
const FLY_BIN = path.join(FLY_INSTALL_DIR, 'bin', BIN_NAME);

let flyBinPath = null;
let installationPromise = null;
let lastInstallError = null;

app.use(cors());
app.use(express.json());

// --- INITIALIZATION ---
async function ensureDirs() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
        await fs.mkdir(VERCEL_HOME, { recursive: true });
        await fs.mkdir(FLY_INSTALL_DIR, { recursive: true });
        await fs.mkdir(path.dirname(FLY_BIN), { recursive: true });
        
        if (!IS_VERCEL) {
            const files = await fs.readdir(TEMP_DIR);
            const now = Date.now();
            for (const file of files) {
                const filePath = path.join(TEMP_DIR, file);
                const stats = await fs.stat(filePath).catch(() => null);
                if (stats && now - stats.mtimeMs > 3600000) { 
                    await fs.rm(filePath, { recursive: true, force: true }).catch(() => {});
                }
            }
        }
    } catch (e) {
        if (e.code !== 'EEXIST') console.error("Init Error:", e);
    }
}

// --- INSTALLER (Antifragile v3) ---
async function performAntifragileInstallation() {
    const log = (msg) => console.log(`[FlyInstaller] ${msg}`);
    const warn = (msg) => console.warn(`[FlyInstaller] ${msg}`);

    const CHILD_ENV = {
        ...process.env,
        HOME: VERCEL_HOME,
        FLYCTL_INSTALL: FLY_INSTALL_DIR,
        PATH: `${process.env.PATH}${path.delimiter}/bin${path.delimiter}/usr/bin${path.delimiter}/usr/local/bin`
    };

    const verify = async (p) => {
        try {
            if (!p || !existsSync(p)) return false;
            if (!IS_WINDOWS) await fs.chmod(p, 0o755).catch(() => {});
            const { stdout } = await execa(p, ['version'], { 
                env: CHILD_ENV,
                timeout: 5000 
            });
            return stdout.includes('flyctl');
        } catch (e) { 
            return false; 
        }
    };

    if (await verify('flyctl')) return 'flyctl';
    if (await verify(FLY_BIN)) return FLY_BIN;
    
    const homeFly = path.join(os.homedir(), '.fly', 'bin', BIN_NAME);
    if (!IS_VERCEL && await verify(homeFly)) return homeFly;

    log(`Starting installation to ${FLY_BIN}...`);
    const binDir = path.dirname(FLY_BIN);

    // Strategy 1: Shell
    if (!IS_WINDOWS) {
        try {
            await execa('sh', ['-c', 'curl -L https://fly.io/install.sh | sh'], { env: CHILD_ENV, timeout: 45000 });
            if (await verify(FLY_BIN)) return FLY_BIN;
        } catch (e) { }

        try {
            await execa('sh', ['-c', 'wget -qO- https://fly.io/install.sh | sh'], { env: CHILD_ENV, timeout: 45000 });
            if (await verify(FLY_BIN)) return FLY_BIN;
        } catch (e) { }
    }

    // Strategy 2: Direct Download
    log("Strategy 2: Direct Download Matrix");
    try {
        const platform = os.platform();
        const arch = os.arch();
        let osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
        let archName = (arch === 'arm64') ? 'arm64' : (arch === 'x64' ? 'x86_64' : arch);

        let versionsToTry = [];
        try {
            const releaseRes = await fetch('https://api.github.com/repos/superfly/flyctl/releases/latest');
            if (releaseRes.ok) {
                const releaseData = await releaseRes.json();
                versionsToTry.push(releaseData.tag_name.replace(/^v/, ''));
            }
        } catch (e) { }

        versionsToTry.push("0.4.11"); // Stable fallback
        versionsToTry = [...new Set(versionsToTry)];

        const fileExts = platform === 'win32' ? ['.zip'] : ['.tar.gz'];
        
        for (const version of versionsToTry) {
            log(`Attempting version: v${version}`);
            for (const ext of fileExts) {
                const fileName = `flyctl_${version}_${osName}_${archName}${ext}`;
                const url = `https://github.com/superfly/flyctl/releases/download/v${version}/${fileName}`;
                
                try {
                    const tmpPath = path.join(VERCEL_HOME, `fly_dl_${uuidv4()}${ext}`);
                    const response = await fetch(url);
                    if (!response.ok) continue;

                    const fileStream = createWriteStream(tmpPath);
                    await pipeline(response.body, fileStream);

                    if (ext === '.zip') {
                        new AdmZip(tmpPath).extractAllTo(binDir, true);
                    } else {
                        if (tar) await tar.x({ file: tmpPath, cwd: binDir });
                        else await execa('tar', ['-xzf', tmpPath, '-C', binDir], { env: CHILD_ENV });
                    }
                    await fs.unlink(tmpPath).catch(() => {});

                    const walk = async (dir) => {
                        const list = await fs.readdir(dir, { withFileTypes: true });
                        for (const item of list) {
                            const itemPath = path.join(dir, item.name);
                            if (item.isDirectory()) {
                                if (await walk(itemPath)) return true;
                            } else if (item.name === BIN_NAME) {
                                if (itemPath !== FLY_BIN) await fs.rename(itemPath, FLY_BIN).catch(() => {});
                                if (!IS_WINDOWS) await fs.chmod(FLY_BIN, 0o755).catch(() => {});
                                return true;
                            }
                        }
                        return false;
                    };
                    
                    if (await walk(binDir)) {
                         if (await verify(FLY_BIN)) {
                             log(`✅ Successfully installed v${version}`);
                             return FLY_BIN;
                         }
                    }
                } catch (dlErr) { }
            }
        }
    } catch (e) { warn(`Strategy 2 failed: ${e.message}`); }
    throw new Error(`Installation failed.`);
}

async function getFlyExe() {
    if (flyBinPath && existsSync(flyBinPath)) return flyBinPath;
    if (!installationPromise) {
        installationPromise = performAntifragileInstallation()
            .then(p => { flyBinPath = p; installationPromise = null; return p; })
            .catch(e => { lastInstallError = e.message; installationPromise = null; throw e; });
    }
    return installationPromise;
}

(async () => {
    await ensureDirs();
    if (!IS_VERCEL) getFlyExe().catch(() => {});
})();

async function cleanup(dir) {
    if (dir && dir.startsWith(TEMP_DIR)) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

async function downloadRepo(repoUrl, targetDir, githubToken) {
    const cleanUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
    const archiveUrl = `${cleanUrl}/archive/HEAD.zip`;
    const headers = githubToken ? { 'Authorization': `token ${githubToken}` } : {};

    const res = await fetch(archiveUrl, { headers });
    if (!res.ok) throw new Error(`Repo download failed: ${res.status}`);
    
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    zip.extractAllTo(targetDir, true);
    
    const list = await fs.readdir(targetDir);
    const root = list.find(n => !n.startsWith('.'));
    if (root && (await fs.stat(path.join(targetDir, root))).isDirectory()) {
        return path.join(targetDir, root);
    }
    return targetDir;
}

// --- API ROUTES ---

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), env: IS_VERCEL ? 'vercel' : 'node', flyInstalled: !!flyBinPath });
});

app.post('/api/analyze', async (req, res) => {
    const { repoUrl, aiConfig, githubToken, preferExistingConfig } = req.body;
    const sessionId = uuidv4();
    const workDir = path.join(TEMP_DIR, sessionId);
    await fs.mkdir(workDir, { recursive: true }).catch(() => {});

    try {
        if (preferExistingConfig) {
            return res.json({
                success: true, sessionId,
                fly_toml: "# Existing config", dockerfile: null,
                explanation: "Using existing config", envVars: {}, stack: "Existing", files: []
            });
        }

        let repoPath = workDir;
        try { repoPath = await downloadRepo(repoUrl, workDir, githubToken); } catch (e) { }

        const context = await (async () => {
            if (repoPath === workDir) return "No code available.";
            // Expanded list to catch more config types generic to any app
            const files = ['package.json', 'fly.toml', 'Dockerfile', 'requirements.txt', 'go.mod', 'config.yaml', 'config.example.yaml', 'config.defaults.yaml', '.env.example'];
            
            // Recursive crawler for deep config files (limited depth)
            const getFiles = async (dir, depth = 0) => {
                if (depth > 2) return "";
                let c = "";
                const list = await fs.readdir(dir).catch(() => []);
                for (const item of list) {
                    const fullPath = path.join(dir, item);
                    const stats = await fs.stat(fullPath).catch(() => null);
                    if (stats && stats.isDirectory() && !item.startsWith('.')) {
                        c += await getFiles(fullPath, depth + 1);
                    } else if (files.includes(item) || item.endsWith('.config.js') || item.endsWith('.toml') || item.endsWith('.yaml')) {
                        try { 
                            const content = await fs.readFile(fullPath, 'utf8');
                            if (content.length < 10000) c += `\nFile: ${item} (Path: ${fullPath.replace(repoPath, '')}):\n${content}\n`;
                        } catch {}
                    }
                }
                return c;
            };
            return (await getFiles(repoPath)).slice(0, 15000); // Increased context window
        })();

        const hasDockerfile = context.includes("Dockerfile:");

        // --- UNIVERSAL PROMPT ---
        const prompt = `DevOps Architect Task: Generate Fly.io configuration for this repo. Context provided.
        
        RETURN JSON: {fly_toml, dockerfile, explanation, envVars:[{name, reason}], stack, healthCheckPath, files:[{name, content}]}.

        ANALYSIS RULES:
        1. **Detect App Type**: 
           - 'WEB': Standard HTTP app (Node, Python, HTML). Needs HTTP checks.
           - 'NETWORK': Low-level TCP/UDP service (DNS server, Proxy, VPN). **MUST use TCP checks**, NOT HTTP.
        2. **Binding**: ALL apps must bind to '0.0.0.0' (IPv4) or '::' (IPv6). If code binds to '127.0.0.1', override via Environment Variable or Config File.
        3. **Config Files**: If the app relies on a config file (e.g., config.yaml, settings.toml) that is MISSING (only .example exists), YOU MUST GENERATE IT in the 'files' array.
           - **CRITICAL**: If generating DNS upstreams in YAML/JSON, use VALID SCHEMES (e.g., 'udp://1.1.1.1:53', 'tcp://1.1.1.1:53'). DO NOT put raw IPs where URIs are expected.
        4. **Dockerfile**: 
           - If missing, generate a robust Multi-Stage build.
           - If Go: Use 'golang:alpine' builder -> 'alpine' runner. Install 'ca-certificates'.
           - If Node: Use 'node:alpine'.
        5. **fly.toml**:
           - Use SINGLE QUOTES.
           - [[vm]] must have 'memory' AND 'memory_mb'.
           - services.internal_port must match the container's listening port.

        OUTPUT TEMPLATE:
        {
          "fly_toml": "...",
          "dockerfile": "...", 
          "files": [ { "name": "config.yaml", "content": "..." } ], 
          "envVars": [ { "name": "PORT", "reason": "Standard" } ]
        }
        `;

        try {
            const provider = aiConfig?.provider || 'gemini';
            let json;

            if (provider === 'openrouter') {
                const openai = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: aiConfig.apiKey });
                const completion = await openai.chat.completions.create({
                    model: aiConfig.model || 'google/gemini-2.0-flash-exp:free',
                    messages: [{ role: 'system', content: 'JSON only.' }, { role: 'user', content: prompt }],
                    response_format: { type: 'json_object' }
                });
                json = JSON.parse(completion.choices[0].message.content);
            } else {
                const apiKey = aiConfig?.apiKey || process.env.API_KEY;
                const ai = new GoogleGenAI({ apiKey });
                const result = await ai.models.generateContent({
                    model: aiConfig?.model || 'gemini-3-flash-preview',
                    contents: prompt,
                    config: { responseMimeType: "application/json" }
                });
                json = JSON.parse(result.text);
            }
            
            if (hasDockerfile) json.dockerfile = null;

            // Universal Env Var formatting
            const envVars = {};
            if (Array.isArray(json.envVars)) json.envVars.forEach(e => envVars[e.name] = e.reason);
            else if (json.envVars) Object.entries(json.envVars).forEach(([k, v]) => envVars[k] = v);

            res.json({ success: true, sessionId, ...json, envVars });

        } catch (e) {
            console.error("AI Error:", e);
            res.json({ success: true, sessionId, fly_toml: `app='app'`, dockerfile: null, explanation: "Analysis Failed: " + e.message, envVars: {}, stack: "Error", files: [] });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/deploy', async (req, res) => {
    const { sessionId, flyToken, flyToml, dockerfile, appName, region, repoUrl, githubToken, preferExistingConfig, files } = req.body;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = (msg, type = 'info') => res.write(`data: ${JSON.stringify({ message: msg, type })}\n\n`);
    const workDir = path.join(TEMP_DIR, sessionId);

    try {
        const flyExe = await getFlyExe();
        const exeDir = path.dirname(flyExe);
        
        const DEPLOY_ENV = {
            ...process.env,
            FLY_API_TOKEN: flyToken,
            HOME: VERCEL_HOME,
            FLYCTL_INSTALL: FLY_INSTALL_DIR,
            PATH: `${exeDir}${path.delimiter}${process.env.PATH}`,
            NO_COLOR: "1",
            CI: "1",
            FLY_NO_UPDATE_CHECK: "1",
            FLY_CHECK_UPDATE: "false"
        };

        let targetDir = workDir;
        try {
            await fs.access(workDir);
            const list = await fs.readdir(workDir);
            if (list.length === 0) throw new Error("empty");
            const root = list.find(n => !n.startsWith('.'));
            if (root && (await fs.stat(path.join(workDir, root))).isDirectory()) {
                targetDir = path.join(workDir, root);
            }
        } catch {
            stream("Downloading source...", "info");
            await fs.mkdir(workDir, { recursive: true });
            targetDir = await downloadRepo(repoUrl, workDir, githubToken);
        }

        stream("Writing config...", "info");
        const tomlPath = path.join(targetDir, 'fly.toml');
        
        let tomlContent = flyToml;
        if (preferExistingConfig) {
             try { tomlContent = await fs.readFile(tomlPath, 'utf8'); } catch { throw new Error("Missing fly.toml"); }
        }
        
        // Universal TOML Cleanup (Remove hardcoded app/region to let CLI handle it via args or new config)
        tomlContent = `app = '${appName}'\nprimary_region = '${region}'\n` + 
            tomlContent.replace(/^app\s*=.*$/gm, '')
                       .replace(/^primary_region\s*=.*$/gm, '');
            
        await fs.writeFile(tomlPath, tomlContent);
        
        if (dockerfile && typeof dockerfile === 'string' && dockerfile.trim().length > 0) {
            await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerfile);
        }

        // --- UNIVERSAL FILE GENERATOR ---
        // Writes ANY config files the AI deemed necessary (config.yaml, .env, script.sh)
        if (files && Array.isArray(files)) {
            for (const f of files) {
                const filePath = path.join(targetDir, f.name);
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                await fs.writeFile(filePath, f.content);
                stream(`Generated configuration: ${f.name}`, 'info');
            }
        }

        // --- CONTEXT SANITIZER (Universal) ---
        // Ensures hidden config files (like .env or config.yaml) are NOT ignored by Docker
        stream("🛡️ Sanitizing Build Context...", "info");
        const dockerIgnorePath = path.join(targetDir, '.dockerignore');
        try {
            await fs.rm(dockerIgnorePath, { force: true });
            // Whitelist-style ignore (Allow everything, ignore specific heavy junk)
            await fs.writeFile(dockerIgnorePath, `
.git
node_modules
dist
            `.trim());
        } catch (e) { }

        stream("Registering app...", "info");
        try {
            const createProc = execa(flyExe, ['apps', 'create', appName], { env: DEPLOY_ENV });
            await createProc;
        } catch (e) {
            const err = (e.stderr || '') + (e.stdout || '');
            if (err.includes('taken') || err.includes('exists')) stream("App exists, updating...", "warning");
        }
        
        await new Promise(r => setTimeout(r, 2000));

        stream("Deploying...", "log");
        const proc = execa(flyExe, ['deploy', '--ha=false', '--wait-timeout', '600', '--remote-only', '--config', 'fly.toml'], {
            cwd: targetDir,
            env: DEPLOY_ENV
        });

        if (proc.stdout) proc.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && stream(l.trim(), 'log')));
        if (proc.stderr) proc.stderr.on('data', d => d.toString().split('\n').forEach(l => l.trim() && stream(l.trim(), 'log')));

        await proc;

        const statusProc = await execa(flyExe, ['status', '--json'], { env: DEPLOY_ENV, cwd: targetDir });
        const status = JSON.parse(statusProc.stdout);
        
        res.write(`data: ${JSON.stringify({ type: 'success', appUrl: `https://${status.Hostname}`, appName: status.Name })}\n\n`);

    } catch (e) {
        stream(`Error: ${e.message}`, 'error');
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
    app.listen(port, '0.0.0.0', () => console.log(`🚀 Server on ${port}`));
}

export default app;