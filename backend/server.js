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

// Environment Detection & Pathing
const IS_VERCEL = process.env.VERCEL === '1' || !!process.env.NOW_REGION;
const IS_WINDOWS = os.platform() === 'win32';
const BIN_NAME = IS_WINDOWS ? 'flyctl.exe' : 'flyctl';

// Serverless: ALWAYS use /tmp. Persistent: use local .fly
const BASE_WORK_DIR = IS_VERCEL ? os.tmpdir() : __dirname;
const TEMP_DIR = path.join(BASE_WORK_DIR, 'fly_deployer_workspaces');
const FLY_INSTALL_DIR = path.join(BASE_WORK_DIR, '.fly');
const FLY_BIN = path.join(FLY_INSTALL_DIR, 'bin', BIN_NAME);

// Global state for binary availability and installation locking
let flyBinPath = null;
let installationPromise = null;
let lastInstallError = null;

app.use(cors());
app.use(express.json());

// --- Core Initialization ---

async function ensureTempDir() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
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
        if (e.code !== 'EEXIST') console.error("Initialization Error:", e);
    }
}

/**
 * THE NUCLEAR INSTALLER
 * Maximum fallbacks. Mutex locking. Relocation logic.
 */
async function performAntifragileInstallation() {
    const log = (msg) => console.log(`[FlyInstaller] ${msg}`);
    const warn = (msg) => console.warn(`[FlyInstaller] ${msg}`);

    const verify = async (p) => {
        try {
            if (!p || !existsSync(p)) return false;
            if (!IS_WINDOWS) await fs.chmod(p, 0o755).catch(() => {});
            const { stdout } = await execa(p, ['version'], { timeout: 8000 });
            return stdout.includes('flyctl');
        } catch (e) { 
            log(`Verification failed for ${p}: ${e.message}`);
            return false; 
        }
    };

    // 1. Initial Quick Checks (Already available?)
    if (await verify('flyctl')) return 'flyctl';
    if (await verify(FLY_BIN)) return FLY_BIN;
    const homeFly = path.join(os.homedir(), '.fly', 'bin', BIN_NAME);
    if (await verify(homeFly)) return homeFly;

    log("🚀 Starting Nuclear Installation Sequence...");
    const binDir = path.dirname(FLY_BIN);
    await fs.mkdir(binDir, { recursive: true });

    // --- STRATEGY 1: Official Shell Pipe (If curl/wget present) ---
    if (!IS_WINDOWS) {
        log("Strategy 1: Attempting Official Shell Installer...");
        try {
            await execa('sh', ['-c', 'curl -L https://fly.io/install.sh | sh'], {
                env: { ...process.env, FLYCTL_INSTALL: FLY_INSTALL_DIR },
                timeout: 30000
            });
            if (await verify(FLY_BIN)) return FLY_BIN;
        } catch (e) { warn(`Curl failed: ${e.message}`); }

        try {
            await execa('sh', ['-c', 'wget -qO- https://fly.io/install.sh | sh'], {
                env: { ...process.env, FLYCTL_INSTALL: FLY_INSTALL_DIR },
                timeout: 30000
            });
            if (await verify(FLY_BIN)) return FLY_BIN;
        } catch (e) { warn(`Wget failed: ${e.message}`); }
    }

    // --- STRATEGY 2: Direct Binary Fetch & JS-Extraction (Most resilient) ---
    log("Strategy 2: Direct Node Download & JS-based Extraction...");
    try {
        const platform = os.platform();
        const arch = os.arch();
        let osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
        let archName = (arch === 'arm64') ? 'arm64' : (arch === 'x64' ? 'x86_64' : arch);

        // Fetch latest version via API or fallback to hardcoded stable
        let version = "0.2.14"; // Hardcoded fallback
        try {
            const releaseRes = await fetch('https://api.github.com/repos/superfly/flyctl/releases/latest');
            if (releaseRes.ok) {
                const releaseData = await releaseRes.json();
                version = releaseData.tag_name.replace(/^v/, '');
            }
        } catch (apiErr) { warn("GitHub API rate limited/down, using stable fallback version."); }

        const extensions = ['.tar.gz', '.zip'];
        for (const ext of extensions) {
            const assetName = `flyctl_${version}_${osName}_${archName}${ext}`;
            const downloadUrl = `https://github.com/superfly/flyctl/releases/download/v${version}/${assetName}`;
            
            log(`Attempting download: ${downloadUrl}`);
            const response = await fetch(downloadUrl);
            if (!response.ok) continue;

            const tmpArchive = path.join(BASE_WORK_DIR, `flyctl_pkg_${uuidv4()}${ext}`);
            const fileStream = createWriteStream(tmpArchive);
            await pipeline(response.body, fileStream);

            log("Download finished. Extracting...");
            if (ext === '.zip') {
                new AdmZip(tmpArchive).extractAllTo(binDir, true);
            } else {
                if (tar) {
                    await tar.x({ file: tmpArchive, cwd: binDir }).catch(() => execa('tar', ['-xzf', tmpArchive, '-C', binDir]));
                } else {
                    await execa('tar', ['-xzf', tmpArchive, '-C', binDir]);
                }
            }
            await fs.unlink(tmpArchive).catch(() => {});

            // RELOCATION: Binaries often end up in 'bin/' inside the archive or root
            const findAndRelocate = async (dir) => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { if (await findAndRelocate(fullPath)) return true; }
                    else if (entry.name === BIN_NAME) {
                        if (fullPath !== FLY_BIN) {
                            log(`Relocating ${fullPath} -> ${FLY_BIN}`);
                            await fs.rename(fullPath, FLY_BIN).catch(() => {});
                        }
                        return true;
                    }
                }
                return false;
            };
            await findAndRelocate(binDir);

            if (await verify(FLY_BIN)) return FLY_BIN;
        }
    } catch (e) { warn(`Strategy 2 failed: ${e.message}`); }

    throw new Error("UNRECOVERABLE: flyctl installation impossible in this environment.");
}

/**
 * Thread-safe wrapper for binary acquisition
 */
async function getFlyExe() {
    if (flyBinPath && await fs.access(flyBinPath).then(() => true).catch(() => false)) return flyBinPath;

    // Mutex: only one installation at a time
    if (!installationPromise) {
        installationPromise = performAntifragileInstallation().then(path => {
            flyBinPath = path;
            installationPromise = null;
            return path;
        }).catch(err => {
            lastInstallError = err.message;
            installationPromise = null;
            throw err;
        });
    }

    return await installationPromise;
}

// Background Warm-up for Standard Node environments
if (!IS_VERCEL) {
    (async () => {
        await ensureTempDir();
        getFlyExe().catch(() => {});
    })();
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
        if ((await fs.stat(internalPath).catch(() => ({ isDirectory: () => false }))).isDirectory()) return internalPath;
    }
    return targetDir;
}

// --- Routes ---

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(), 
        env: IS_VERCEL ? 'vercel' : 'node', 
        flyReady: !!flyBinPath,
        lastError: lastInstallError
    });
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
            console.error("AI Analysis Failed, fallback to safe-mode:", aiError);
            res.json({ 
                success: true, sessionId, 
                fly_toml: `app = "change-me"\nprimary_region = "iad"\n\n[http_service]\n  internal_port = 8080\n  force_https = true\n  auto_stop_machines = true\n  auto_start_machines = true\n\n[[vm]]\n  cpu_kind = "shared"\n  cpus = 1\n  memory_mb = 256`,
                dockerfile: `FROM node:alpine\nWORKDIR /app\nCOPY . .\nRUN npm install --production\nCMD ["npm", "start"]`,
                explanation: "⚠️ AI Analysis failed. Using Node.js safe-default.",
                envVars: { "PORT": "Internal port" }, stack: "Fallback", healthCheckPath: "/"
            });
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
        const flyExe = await getFlyExe();
        const localPath = path.dirname(flyExe);
        const envPath = `${localPath}${path.delimiter}${process.env.PATH}`;

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
            try { tomlData = await fs.readFile(tomlPath, 'utf8'); } catch { throw new Error("fly.toml not found in repo."); }
        }
        tomlData = `app = "${appName}"\nprimary_region = "${region}"\n` + tomlData.replace(/^app\s*=.*$/gm, '').replace(/^primary_region\s*=.*$/gm, '').replace(/^\[app\]\s*$/gm, '');
        await fs.writeFile(tomlPath, tomlData);
        if (dockerfile) await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerfile);

        stream(`Authenticating with Fly.io...`, "info");
        try {
            await execa(flyExe, ['apps', 'create', appName], { 
                env: { ...process.env, FLY_API_TOKEN: flyToken, NO_COLOR: "1", PATH: envPath } 
            });
            stream(`New app '${appName}' registered.`, "success");
        } catch (e) {
            const errStr = (e.stderr || '') + (e.stdout || '') + (e.message || '');
            if (errStr.includes('taken') || errStr.includes('exists')) stream("App already exists, updating...", "warning");
            else throw new Error(`App registration failed: ${e.message}`);
        }

        stream("Launching deployment (Remote Build)...", "log");
        const deploy = execa(flyExe, ['deploy', '--ha=false', '--wait-timeout', '600'], {
            cwd: targetDir,
            env: { ...process.env, FLY_API_TOKEN: flyToken, NO_COLOR: "1", PATH: envPath }
        });

        if (deploy.stdout) deploy.stdout.on('data', c => c.toString().split('\n').forEach(l => l.trim() && stream(l.trim(), 'log')));
        if (deploy.stderr) deploy.stderr.on('data', c => c.toString().split('\n').forEach(l => l.trim() && stream(l.trim(), 'log')));

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