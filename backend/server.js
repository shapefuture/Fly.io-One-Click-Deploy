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

// --- ENVIRONMENT DETECTION ---
// Detect Vercel, AWS Lambda, or generic container environments
const IS_VERCEL = process.env.VERCEL === '1' || !!process.env.NOW_REGION || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const IS_WINDOWS = os.platform() === 'win32';
const BIN_NAME = IS_WINDOWS ? 'flyctl.exe' : 'flyctl';

// --- PATH CONFIGURATION ---
// In Serverless/Vercel, ONLY /tmp is writable. We must rewrite HOME to /tmp to avoid permission errors.
const BASE_WORK_DIR = IS_VERCEL ? os.tmpdir() : __dirname;
// Create a fake HOME directory in tmp for Vercel to store configs
const VERCEL_HOME = path.join(os.tmpdir(), 'fly_home');
const TEMP_DIR = path.join(BASE_WORK_DIR, 'fly_deployer_workspaces');
const FLY_INSTALL_DIR = path.join(VERCEL_HOME, '.fly');
const FLY_BIN = path.join(FLY_INSTALL_DIR, 'bin', BIN_NAME);

// Global locks
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
        
        // Cleanup old workspaces on persistent servers
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

/**
 * NUCLEAR INSTALLER v3 (Vercel-Optimized)
 */
async function performAntifragileInstallation() {
    const log = (msg) => console.log(`[FlyInstaller] ${msg}`);
    const warn = (msg) => console.warn(`[FlyInstaller] ${msg}`);

    // Critical: Override HOME for child processes in Vercel
    const CHILD_ENV = {
        ...process.env,
        HOME: VERCEL_HOME,
        FLYCTL_INSTALL: FLY_INSTALL_DIR,
        // Ensure path includes basic bin locations
        PATH: `${process.env.PATH}${path.delimiter}/bin${path.delimiter}/usr/bin${path.delimiter}/usr/local/bin`
    };

    const verify = async (p) => {
        try {
            if (!p || !existsSync(p)) return false;
            // Force execute permissions
            if (!IS_WINDOWS) {
                await fs.chmod(p, 0o755).catch(() => {});
            }
            const { stdout } = await execa(p, ['version'], { 
                env: CHILD_ENV,
                timeout: 5000 
            });
            return stdout.includes('flyctl');
        } catch (e) { 
            return false; 
        }
    };

    // 1. Check existing
    if (await verify('flyctl')) return 'flyctl';
    if (await verify(FLY_BIN)) return FLY_BIN;
    
    // Check local dev path
    const homeFly = path.join(os.homedir(), '.fly', 'bin', BIN_NAME);
    if (!IS_VERCEL && await verify(homeFly)) return homeFly;

    log(`Starting installation to ${FLY_BIN}...`);
    const binDir = path.dirname(FLY_BIN);

    // --- STRATEGY 1: Shell (curl/wget) ---
    // Best for environments with standard tools
    if (!IS_WINDOWS) {
        try {
            // Try curl
            log("Strategy 1: curl | sh");
            await execa('sh', ['-c', 'curl -L https://fly.io/install.sh | sh'], {
                env: CHILD_ENV,
                timeout: 45000
            });
            if (await verify(FLY_BIN)) return FLY_BIN;
        } catch (e) { /* ignore */ }

        try {
            // Try wget
            log("Strategy 1b: wget | sh");
            await execa('sh', ['-c', 'wget -qO- https://fly.io/install.sh | sh'], {
                env: CHILD_ENV,
                timeout: 45000
            });
            if (await verify(FLY_BIN)) return FLY_BIN;
        } catch (e) { /* ignore */ }
    }

    // --- STRATEGY 2: Node.js Direct Download (The "Vercel Special") ---
    log("Strategy 2: Direct Download Matrix");
    try {
        const platform = os.platform();
        const arch = os.arch();
        
        // Exact casing required for GitHub Releases
        // Linux -> Linux, Darwin -> macOS, Windows_NT -> Windows
        let osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
        let archName = (arch === 'arm64') ? 'arm64' : (arch === 'x64' ? 'x86_64' : arch);

        // Fallback version priority list
        let versionsToTry = [];

        // 1. Attempt to fetch latest from API
        try {
            const releaseRes = await fetch('https://api.github.com/repos/superfly/flyctl/releases/latest');
            if (releaseRes.ok) {
                const releaseData = await releaseRes.json();
                versionsToTry.push(releaseData.tag_name.replace(/^v/, ''));
            }
        } catch (e) { warn("GitHub API failed, skipping latest version check."); }

        // 2. Add requested robust fallback (0.4.11) and legacy fallback (0.2.22)
        versionsToTry.push("0.4.11");
        versionsToTry.push("0.2.22");
        
        // Deduplicate
        versionsToTry = [...new Set(versionsToTry)];

        const fileExts = platform === 'win32' ? ['.zip'] : ['.tar.gz'];
        
        for (const version of versionsToTry) {
            log(`Attempting version: v${version}`);
            
            for (const ext of fileExts) {
                const fileName = `flyctl_${version}_${osName}_${archName}${ext}`;
                const url = `https://github.com/superfly/flyctl/releases/download/v${version}/${fileName}`;
                
                log(`Downloading artifact: ${url}`);
                
                try {
                    const tmpPath = path.join(VERCEL_HOME, `fly_dl_${uuidv4()}${ext}`);
                    const response = await fetch(url);
                    
                    if (!response.ok) {
                        warn(`v${version} not found at ${url} (${response.status})`);
                        continue;
                    }

                    const fileStream = createWriteStream(tmpPath);
                    await pipeline(response.body, fileStream);

                    log(`Extracting v${version}...`);
                    if (ext === '.zip') {
                        new AdmZip(tmpPath).extractAllTo(binDir, true);
                    } else {
                        if (tar) {
                            await tar.x({ file: tmpPath, cwd: binDir });
                        } else {
                            await execa('tar', ['-xzf', tmpPath, '-C', binDir], { env: CHILD_ENV });
                        }
                    }
                    
                    await fs.unlink(tmpPath).catch(() => {});

                    // Relocation Logic (Flatten structure)
                    // Archives often have nested folders like 'flyctl_0.4.11_Linux_x86_64/flyctl'
                    const walk = async (dir) => {
                        const list = await fs.readdir(dir, { withFileTypes: true });
                        for (const item of list) {
                            const itemPath = path.join(dir, item.name);
                            if (item.isDirectory()) {
                                if (await walk(itemPath)) return true;
                            } else if (item.name === BIN_NAME) {
                                if (itemPath !== FLY_BIN) {
                                    log(`Moving ${itemPath} -> ${FLY_BIN}`);
                                    await fs.rename(itemPath, FLY_BIN).catch(() => {});
                                }
                                // Ensure executable (critical for Vercel/Linux)
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
                } catch (dlErr) {
                    warn(`Download/Extract failed for v${version}: ${dlErr.message}`);
                }
            }
        }

    } catch (e) {
        warn(`Strategy 2 Matrix failed: ${e.message}`);
    }

    throw new Error(`Installation failed. Vercel: ${IS_VERCEL}, Platform: ${os.platform()}`);
}

async function getFlyExe() {
    if (flyBinPath && existsSync(flyBinPath)) return flyBinPath;
    
    if (!installationPromise) {
        installationPromise = performAntifragileInstallation()
            .then(p => {
                flyBinPath = p;
                installationPromise = null;
                return p;
            })
            .catch(e => {
                lastInstallError = e.message;
                installationPromise = null;
                throw e;
            });
    }
    return installationPromise;
}

// Warmup
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
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(), 
        env: IS_VERCEL ? 'vercel' : 'node', 
        flyInstalled: !!flyBinPath,
        error: lastInstallError
    });
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
                explanation: "Using existing config", envVars: {}, stack: "Existing"
            });
        }

        let repoPath = workDir;
        try {
            repoPath = await downloadRepo(repoUrl, workDir, githubToken);
        } catch (e) { console.warn("Repo download failed, strictly inferring"); }

        const context = await (async () => {
            if (repoPath === workDir) return "No code available.";
            const files = ['package.json', 'fly.toml', 'Dockerfile', 'requirements.txt', 'go.mod'];
            let c = "";
            for (const f of files) {
                try { c += `\n${f}:\n` + await fs.readFile(path.join(repoPath, f), 'utf8'); } catch {}
            }
            return c.slice(0, 8000);
        })();

        const hasDockerfile = context.includes("Dockerfile:");

        // STRICT PROMPT: Enforce SINGLE QUOTES and PROTECT existing Dockerfiles
        const prompt = `DevOps Task: Config for Fly.io. Repo: ${repoUrl}. Context: ${context}. Return JSON: {fly_toml, dockerfile, explanation, envVars:[{name, reason}], stack, healthCheckPath}.
        
        CRITICAL RULES:
        1. fly.toml strings MUST use SINGLE QUOTES (e.g. app = 'name').
        2. [[vm]] section MUST include BOTH: memory = '1gb' AND memory_mb = 1024 (or 256).
        3. If a Dockerfile ALREADY EXISTS in the context, set the 'dockerfile' field in JSON to null. DO NOT generate a new one.
        4. If generating a Dockerfile (only if missing), use JSON array syntax for CMD.
        
        Preferred fly.toml Structure:
        app = 'app-name'
        primary_region = 'iad'

        [build]
        dockerfile = 'Dockerfile'

        [[vm]]
        memory = '1gb'
        cpu_kind = 'shared'
        cpus = 1
        memory_mb = 256

        [[services]]
        internal_port = 8080
        protocol = 'tcp'
        auto_stop_machines = true
        auto_start_machines = true
        min_machines_running = 1
        
        [[services.ports]]
            port = 80
            handlers = ['http']
        [[services.ports]]
            port = 443
            handlers = ['tls', 'http']
        `;

        try {
            const provider = aiConfig?.provider || 'gemini';
            let json;

            if (provider === 'openrouter') {
                const openai = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: aiConfig.apiKey });
                const completion = await openai.chat.completions.create({
                    model: aiConfig.model || 'google/gemini-2.0-flash-exp:free',
                    messages: [{ role: 'system', content: 'JSON only. Valid TOML. Single quotes.' }, { role: 'user', content: prompt }],
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
            
            // STRICT PROTECTION: If context had Dockerfile, force null to prevent overwrite
            if (hasDockerfile) {
                json.dockerfile = null;
            }

            const envVars = {};
            if (json.envVars) json.envVars.forEach(e => envVars[e.name] = e.reason);
            res.json({ success: true, sessionId, ...json, envVars });

        } catch (e) {
            console.error("AI Error:", e);
            res.json({
                success: true, sessionId,
                // FALLBACK with SINGLE QUOTES and DUAL MEMORY settings
                fly_toml: `app = 'app'
primary_region = 'iad'

[build]
  dockerfile = 'Dockerfile'

[[vm]]
  memory = '1gb'
  cpu_kind = 'shared'
  cpus = 1
  memory_mb = 256

[[services]]
  internal_port = 8080
  protocol = 'tcp'
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1
  
  [[services.ports]]
    port = 80
    handlers = ['http']
  [[services.ports]]
    port = 443
    handlers = ['tls', 'http']
`,
                // Don't overwrite if it exists
                dockerfile: hasDockerfile ? null : 'FROM node:18-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["npm", "start"]',
                explanation: "Fallback config used.",
                envVars: {PORT: "8080"}, stack: "Fallback"
            });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/deploy', async (req, res) => {
    const { sessionId, flyToken, flyToml, dockerfile, appName, region, repoUrl, githubToken, preferExistingConfig } = req.body;
    
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
        
        // Sanitize TOML: Force SINGLE QUOTES for app/region
        tomlContent = `app = '${appName}'\nprimary_region = '${region}'\n` + 
            tomlContent.replace(/^app\s*=.*$/gm, '')
                       .replace(/^primary_region\s*=.*$/gm, '')
                       .replace(/^checks\s*=\s*".*"/gm, '')
                       .replace(/^checks\s*=\s*'.*'/gm, ''); 
            
        await fs.writeFile(tomlPath, tomlContent);
        
        // CRITICAL: Only write Dockerfile if specifically provided AND NOT NULL
        // This protects the 'scratch' dockerfile from being overwritten
        if (dockerfile && typeof dockerfile === 'string' && dockerfile.trim().length > 0) {
            await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerfile);
        }

        stream("Registering app...", "info");
        try {
            const createProc = execa(flyExe, ['apps', 'create', appName], { env: DEPLOY_ENV });
            if (createProc.stdout) createProc.stdout.on('data', d => stream(`[Reg] ${d.toString().trim()}`, 'log'));
            if (createProc.stderr) createProc.stderr.on('data', d => stream(`[Reg] ${d.toString().trim()}`, 'log'));
            await createProc;
            stream("App registered.", "info");
        } catch (e) {
            const err = (e.stderr || '') + (e.stdout || '');
            if (err.includes('taken') || err.includes('exists')) stream("App exists, updating...", "warning");
            else {
                if (!err.includes('taken') && !err.includes('exists')) throw new Error(`Registration failed: ${e.message}`);
            }
        }

        await new Promise(r => setTimeout(r, 2000));

        stream("Deploying...", "log");
        
        const proc = execa(flyExe, [
            'deploy', 
            '--ha=false', 
            '--wait-timeout', '600',
            '--remote-only', 
            '--config', 'fly.toml'
        ], {
            cwd: targetDir,
            env: DEPLOY_ENV
        });

        if (proc.stdout) proc.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && stream(l.trim(), 'log')));
        if (proc.stderr) proc.stderr.on('data', d => d.toString().split('\n').forEach(l => l.trim() && stream(l.trim(), 'log')));

        await proc;

        const statusProc = await execa(flyExe, ['status', '--json'], { env: DEPLOY_ENV });
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