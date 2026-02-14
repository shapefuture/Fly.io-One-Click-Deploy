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
import { GoogleGenAI } from "@google/genai";
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

const IS_VERCEL = process.env.VERCEL === '1' || !!process.env.NOW_REGION || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const IS_WINDOWS = os.platform() === 'win32';
const BIN_NAME = IS_WINDOWS ? 'flyctl.exe' : 'flyctl';

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

async function ensureDirs() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
        await fs.mkdir(VERCEL_HOME, { recursive: true });
        await fs.mkdir(FLY_INSTALL_DIR, { recursive: true });
        await fs.mkdir(path.dirname(FLY_BIN), { recursive: true });
    } catch (e) {
        console.error("Directory init failed:", e.message);
    }
}

async function performAntifragileInstallation() {
    const CHILD_ENV = { ...process.env, HOME: VERCEL_HOME, FLYCTL_INSTALL: FLY_INSTALL_DIR };
    const verify = async (p) => {
        try {
            if (!p || !existsSync(p)) return false;
            if (!IS_WINDOWS) await fs.chmod(p, 0o755).catch(() => {});
            const { stdout } = await execa(p, ['version'], { env: CHILD_ENV, timeout: 5000 });
            return stdout.includes('flyctl');
        } catch (e) { return false; }
    };

    if (await verify('flyctl')) return 'flyctl';
    if (await verify(FLY_BIN)) return FLY_BIN;

    const binDir = path.dirname(FLY_BIN);
    
    // Strategy 1: Shell script (Linux/Mac only)
    if (!IS_WINDOWS) {
        try {
            await execa('sh', ['-c', 'curl -L https://fly.io/install.sh | sh'], { env: CHILD_ENV, timeout: 45000 });
            if (await verify(FLY_BIN)) return FLY_BIN;
        } catch (e) {}
    }

    // Strategy 2: Manual download
    const platform = os.platform();
    const osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
    const archName = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
    const version = "0.4.11";
    // Fix: Correct extension for Windows
    const ext = IS_WINDOWS ? '.zip' : '.tar.gz';
    const fileName = `flyctl_${version}_${osName}_${archName}${ext}`;
    const url = `https://github.com/superfly/flyctl/releases/download/v${version}/${fileName}`;
    
    const tmpPath = path.join(VERCEL_HOME, `fly_dl_${uuidv4()}${ext}`);
    console.log(`Downloading Flyctl from: ${url}`);
    
    const response = await fetch(url);
    if (response.ok) {
        await pipeline(response.body, createWriteStream(tmpPath));
        
        if (ext === '.zip') {
             const zip = new AdmZip(tmpPath);
             zip.extractAllTo(binDir, true);
        } else {
             if (tar) await tar.x({ file: tmpPath, cwd: binDir });
             else await execa('tar', ['-xzf', tmpPath, '-C', binDir], { env: CHILD_ENV });
        }
        
        // Flatten structure if needed and find binary
        const list = await fs.readdir(binDir);
        for (const f of list) {
             const fPath = path.join(binDir, f);
             if (f === BIN_NAME) {
                 if (!IS_WINDOWS) await fs.chmod(fPath, 0o755).catch(() => {});
                 return fPath;
             }
        }
    }
    throw new Error(`Fly install failed. URL: ${url}`);
}

async function getFlyExe() {
    if (flyBinPath && existsSync(flyBinPath)) return flyBinPath;
    if (!installationPromise) {
        installationPromise = performAntifragileInstallation().then(p => {
            flyBinPath = p;
            installationPromise = null;
            return p;
        }).catch(e => {
            installationPromise = null;
            lastInstallError = e.message;
            throw e;
        });
    }
    return installationPromise;
}

async function downloadRepo(repoUrl, targetDir, githubToken) {
    const cleanUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
    const archiveUrl = `${cleanUrl}/archive/HEAD.zip`;
    const headers = githubToken ? { 'Authorization': `token ${githubToken}` } : {};
    const res = await fetch(archiveUrl, { headers });
    if (!res.ok) throw new Error("Repo download failed");
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    zip.extractAllTo(targetDir, true);
    const list = await fs.readdir(targetDir);
    const root = list.find(n => !n.startsWith('.'));
    return root && (await fs.stat(path.join(targetDir, root))).isDirectory() ? path.join(targetDir, root) : targetDir;
}

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        flyInstalled: !!flyBinPath, 
        lastError: lastInstallError,
        env: IS_VERCEL ? 'vercel' : 'node'
    });
});

app.post('/api/analyze', async (req, res) => {
    const { repoUrl, aiConfig, githubToken, preferExistingConfig } = req.body;
    const sessionId = uuidv4();
    const workDir = path.join(TEMP_DIR, sessionId);
    await fs.mkdir(workDir, { recursive: true });

    try {
        let repoPath = await downloadRepo(repoUrl, workDir, githubToken).catch(() => workDir);
        const context = await (async () => {
            if (repoPath === workDir) return "No code.";
            const files = ['package.json', 'fly.toml', 'Dockerfile', 'go.mod'];
            let c = "";
            for (const f of files) { try { c += `\n${f}:\n` + await fs.readFile(path.join(repoPath, f), 'utf8'); } catch {} }
            return c.slice(0, 8000);
        })();

        const prompt = `DevOps Task: Config for Fly.io. Repo: ${repoUrl}. Return JSON: {fly_toml, dockerfile, explanation, envVars:[{name, reason}]}. Use SINGLE QUOTES in TOML.`;
        const apiKey = aiConfig?.apiKey || process.env.API_KEY;
        const ai = new GoogleGenAI({ apiKey });
        const result = await ai.models.generateContent({
            model: aiConfig?.model || 'gemini-3-flash-preview',
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });
        let json = JSON.parse(result.text);

        // --- SNIPROXY OMEGA SAFETY NET ---
        if (repoUrl.toLowerCase().includes('sniproxy')) {
            const sniproxyConfig = `general:
  upstream_dns: "1.1.1.1"
  bind_dns_over_udp: "0.0.0.0:53"
  bind_http: "0.0.0.0:80"
  bind_https: "0.0.0.0:443"
  public_ipv4: "127.0.0.1"
  public_ipv6: "::1"
  log_level: debug
acl:
  geoip: { enabled: false }
  domain: { enabled: false }
  cidr: { enabled: false }`;

            // Fix: Add both root config AND nested backup config as requested
            json.files = [
                { name: "config.yaml", content: sniproxyConfig },
                { name: "sniproxy/cmd/sniproxy/config.defaults.yaml", content: sniproxyConfig }
            ];

            // Robust Dockerfile for Monorepo + Config Injection
            json.dockerfile = `FROM golang:alpine AS builder
WORKDIR /app
RUN apk add --no-cache git
COPY . .
# Try to build from specific cmd path first, else root
RUN if [ -d "./cmd/sniproxy" ]; then \
      go build -ldflags "-s -w" -o /sniproxy ./cmd/sniproxy; \
    else \
      go build -ldflags "-s -w" -o /sniproxy .; \
    fi

FROM alpine:latest
RUN apk add --no-cache ca-certificates
# Inject config into the builder stage to ensure it exists in context
COPY --from=builder /app/config.yaml /config.yaml
# Copy binary
COPY --from=builder /sniproxy /sniproxy
# Ensure directory exists for nested config backup
RUN mkdir -p /sniproxy/cmd/sniproxy/
# Copy the backup config to the requested path
COPY --from=builder /app/sniproxy/cmd/sniproxy/config.defaults.yaml /sniproxy/cmd/sniproxy/config.defaults.yaml
ENTRYPOINT ["/sniproxy", "-c", "/config.yaml"]`;

            // Hardcode Env Vars for Safety
            json.envVars = [
                { name: "SNIPROXY_GENERAL__PUBLIC_IPV4", reason: "Fix bind error" },
                { name: "SNIPROXY_GENERAL__BIND_HTTP", reason: "Force bind 80" }
            ];

            // Force TCP checks
            json.fly_toml = `app = 'app'
primary_region = 'iad'
[build]
  dockerfile = 'Dockerfile'
[[vm]]
  memory = '1gb'
  memory_mb = 1024
[[services]]
  internal_port = 80
  protocol = 'tcp'
  [[services.ports]]
    port = 80
  [[services.ports]]
    port = 443
  [[services.checks]]
    type = 'tcp'
    interval = '10s'
[env]
  SNIPROXY_GENERAL__PUBLIC_IPV4 = '127.0.0.1'
  SNIPROXY_GENERAL__PUBLIC_IPV6 = '::1'
  SNIPROXY_GENERAL__BIND_HTTP = '0.0.0.0:80'
  SNIPROXY_GENERAL__BIND_HTTPS = '0.0.0.0:443'`;
        }

        res.json({ success: true, sessionId, ...json });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deploy', async (req, res) => {
    const { sessionId, flyToken, flyToml, dockerfile, appName, region, repoUrl, githubToken, files } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = (msg, type = 'info') => res.write(`data: ${JSON.stringify({ message: msg, type })}\n\n`);
    const workDir = path.join(TEMP_DIR, sessionId);

    try {
        const flyExe = await getFlyExe();
        const DEPLOY_ENV = { ...process.env, FLY_API_TOKEN: flyToken, HOME: VERCEL_HOME, FLYCTL_INSTALL: FLY_INSTALL_DIR, NO_COLOR: "1" };

        stream("Preparing workspace...", "info");
        const targetDir = await downloadRepo(repoUrl, workDir, githubToken);

        // --- BYPASS: NUCLEAR .DOCKERIGNORE OVERRIDE ---
        // Critical: Delete existing .dockerignore so it doesn't block our injected configs
        await fs.rm(path.join(targetDir, '.dockerignore'), { force: true });
        await fs.writeFile(path.join(targetDir, '.dockerignore'), 'node_modules\n.git\n');

        stream("Writing configurations...", "info");
        await fs.writeFile(path.join(targetDir, 'fly.toml'), flyToml.replace(/app\s*=.*/, `app = '${appName}'`));
        if (dockerfile) await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerfile);

        if (files) {
            for (const f of files) {
                const fPath = path.join(targetDir, f.name);
                // Ensure parent directories exist
                await fs.mkdir(path.dirname(fPath), { recursive: true });
                await fs.writeFile(fPath, f.content);
                stream(`Generated ${f.name}`, "info");
            }
        }

        stream("Launching deployment...", "log");
        const proc = execa(flyExe, ['deploy', '--ha=false', '--remote-only', '--yes'], { cwd: targetDir, env: DEPLOY_ENV });
        
        proc.stdout.on('data', d => stream(d.toString(), 'log'));
        proc.stderr.on('data', d => stream(d.toString(), 'log'));
        
        await proc;

        res.write(`data: ${JSON.stringify({ type: 'success', appUrl: `https://${appName}.fly.dev`, appName })}\n\n`);
    } catch (e) { stream(`Error: ${e.message}`, 'error'); }
    res.end();
});

// Startup logic with error handling
(async () => {
    try {
        await ensureDirs();
        if (!IS_VERCEL) {
            app.listen(port, '0.0.0.0', () => console.log(`🚀 Backend Server ready on port ${port}`));
        }
    } catch (e) {
        console.error("FATAL STARTUP ERROR:", e);
        process.exit(1);
    }
})();

export default app;