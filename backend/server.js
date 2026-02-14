import express from 'express';
import { execa } from 'execa';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { TEMP_DIR, VERCEL_HOME, FLY_INSTALL_DIR, IS_VERCEL, IS_WINDOWS } from './lib/config.js';
import { getFlyExe, getFlyInstallState } from './lib/installer.js';
import { downloadRepo } from './lib/git.js';
import { StackDetector } from './lib/stack-detector.js';
import { PolicyEngine } from './lib/policy.js';

console.log('🚀 Starting Backend Server...');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION:', reason);
});

app.use(cors());
app.use(express.json());

// --- INITIALIZATION ---
async function ensureDirs() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
        await fs.mkdir(VERCEL_HOME, { recursive: true });
        await fs.mkdir(FLY_INSTALL_DIR, { recursive: true });
        
        // Cleanup old workspaces
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

// Background install
(async () => {
    await ensureDirs();
    if (!IS_VERCEL) getFlyExe().catch(e => console.error("Fly CLI Background Install Failed:", e.message));
})();

async function cleanup(dir) {
    if (dir && dir.startsWith(TEMP_DIR)) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// --- API ROUTES ---

app.get('/api/health', (req, res) => {
    const installState = getFlyInstallState();
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(), 
        env: IS_VERCEL ? 'vercel' : 'node', 
        flyInstalled: installState.installed 
    });
});

app.post('/api/analyze', async (req, res) => {
    const { repoUrl, aiConfig, githubToken, preferExistingConfig, appName } = req.body;
    const sessionId = uuidv4();
    const workDir = path.join(TEMP_DIR, sessionId);
    await fs.mkdir(workDir, { recursive: true }).catch(() => {});

    try {
        // 1. Download Repo
        let repoPath = workDir;
        try { repoPath = await downloadRepo(repoUrl, workDir, githubToken); } catch (e) { }

        // 2. Detect Strategy
        const strategy = StackDetector.detect(repoPath, repoUrl);
        console.log(`[Analysis] Selected Strategy: ${strategy.name} for ${repoUrl}`);

        // 3. Execute Strategy
        const result = await strategy.analyze(repoPath, repoUrl, appName, aiConfig, preferExistingConfig);

        // 4. Global Post-Processing (The "Healer")
        if (result.fly_toml) {
            if (appName) {
                if (/^app\s*=/m.test(result.fly_toml)) {
                    result.fly_toml = result.fly_toml.replace(/^app\s*=.*$/m, `app = '${appName}'`);
                } else {
                    result.fly_toml = `app = '${appName}'\n` + result.fly_toml;
                }
            }
            
            // Enforce Persistence Policy
            result.fly_toml = result.fly_toml.replace(/auto_stop_machines\s*=\s*true/g, "auto_stop_machines = false");
            result.fly_toml = result.fly_toml.replace(/min_machines_running\s*=\s*0/g, "min_machines_running = 1");
        }

        const envVars = {};
        if (Array.isArray(result.envVars)) result.envVars.forEach(e => envVars[e.name] = e.reason);
        else if (result.envVars) Object.entries(result.envVars).forEach(([k, v]) => envVars[k] = v);

        res.json({ 
            success: true, 
            sessionId, 
            fly_toml: result.fly_toml,
            dockerfile: result.dockerfile,
            explanation: result.explanation,
            files: result.files || [],
            stack: result.stack,
            healthCheckPath: result.healthCheckPath,
            envVars 
        });

    } catch (e) {
        console.error("Analysis Failed:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/deploy', async (req, res) => {
    const { sessionId, flyToken, flyToml, dockerfile, appName, region, repoUrl, githubToken, preferExistingConfig, files, secrets, healthCheckPath } = req.body;
    
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

        // --- PHASE 4: PRE-FLIGHT CHECKS ---
        stream("🕵️ Verifying credentials...", "info");
        try {
            await execa(flyExe, ['orgs', 'list'], { env: DEPLOY_ENV, timeout: 5000 });
        } catch (e) {
            throw new Error("Invalid Fly.io Token or Permissions. Please check your token and try again.");
        }

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
        
        tomlContent = `app = '${appName}'\nprimary_region = '${region}'\n` + 
            tomlContent.replace(/^app\s*=.*$/gm, '')
                       .replace(/^primary_region\s*=.*$/gm, '')
                       .replace(/^checks\s*=\s*".*"/gm, '')
                       .replace(/^checks\s*=\s*'.*'/gm, '')
                       .replace(/auto_stop_machines\s*=\s*true/g, "auto_stop_machines = false")
                       .replace(/min_machines_running\s*=\s*0/g, "min_machines_running = 1");
            
        await fs.writeFile(tomlPath, tomlContent);
        
        if (dockerfile && typeof dockerfile === 'string' && dockerfile.trim().length > 0) {
            await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerfile);
        }

        // Write Extra Files
        if (files && Array.isArray(files)) {
            for (const f of files) {
                const filePath = path.join(targetDir, f.name);
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                await fs.writeFile(filePath, f.content);
                stream(`Generated ${f.name}`, 'info');
            }
        }

        stream("🛡️ Sanitizing Build Context...", "info");
        const dockerIgnorePath = path.join(targetDir, '.dockerignore');
        try {
            await fs.rm(dockerIgnorePath, { force: true });
            await fs.writeFile(dockerIgnorePath, `
.git
node_modules
dist
.env
            `.trim());
        } catch (e) { }

        // --- POLICY ENGINE EXECUTION ---
        try {
            if (PolicyEngine && PolicyEngine.apply) {
                await PolicyEngine.apply(targetDir, appName, region, stream);
            }
        } catch (e) {
            stream(`⚠️ Policy Engine check failed (Non-critical): ${e.message}`, 'warning');
        }

        stream("Registering app...", "info");
        try {
            const createProc = execa(flyExe, ['apps', 'create', appName], { env: DEPLOY_ENV });
            if (createProc.stdout) createProc.stdout.on('data', d => stream(`[Reg] ${d.toString().trim()}`, 'log'));
            await createProc;
        } catch (e) {
            const err = (e.stderr || '') + (e.stdout || '');
            if (err.includes('taken') || err.includes('exists')) stream("App exists, updating...", "warning");
        }
        
        // --- PHASE 2: VOLUME PROVISIONING ---
        // Parse fly.toml for [mounts] to auto-provision volumes
        try {
            const mountsMatch = tomlContent.match(/\[mounts\][\s\S]*?source\s*=\s*['"]?([^'"\s]+)['"]?/);
            if (mountsMatch && mountsMatch[1]) {
                const volName = mountsMatch[1];
                stream(`📦 Detected Volume Request: '${volName}'`, 'info');
                
                // Check if volume exists
                let volExists = false;
                try {
                    const listProc = await execa(flyExe, ['volumes', 'list', '--json', '--app', appName], { env: DEPLOY_ENV });
                    const vols = JSON.parse(listProc.stdout);
                    if (vols.find(v => v.Name === volName)) volExists = true;
                } catch (e) { /* ignore list error (app might be new) */ }

                if (!volExists) {
                    stream(`🛠️ Creating Volume '${volName}' in ${region}...`, 'info');
                    try {
                        await execa(flyExe, [
                            'volumes', 'create', volName,
                            '--region', region,
                            '--size', '1',
                            '--no-encryption',
                            '--app', appName,
                            '--yes'
                        ], { env: DEPLOY_ENV });
                        stream(`✅ Volume '${volName}' created successfully.`, 'success');
                    } catch (e) {
                        stream(`⚠️ Failed to create volume: ${e.message}. Deployment might fail if volume is missing.`, 'warning');
                    }
                } else {
                    stream(`✅ Volume '${volName}' already exists.`, 'info');
                }
            }
        } catch (e) {
            stream(`⚠️ Volume detection failed: ${e.message}`, 'warning');
        }

        // --- PHASE 3: SECRETS MANAGEMENT ---
        if (secrets && Object.keys(secrets).length > 0) {
            stream("🔐 Configuring secrets...", "info");
            try {
                // Filter out empty keys/values
                const secretArgs = Object.entries(secrets)
                    .filter(([k, v]) => k && v)
                    .map(([k, v]) => `${k}=${v}`);

                if (secretArgs.length > 0) {
                    await execa(flyExe, ['secrets', 'set', ...secretArgs, '--app', appName], { env: DEPLOY_ENV });
                    stream(`✅ Set ${secretArgs.length} secret(s) successfully.`, 'success');
                }
            } catch (e) {
                stream(`⚠️ Failed to set secrets: ${e.message}`, 'warning');
            }
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
        const hostname = status.Hostname;

        // --- PHASE 4: HEALTH VERIFICATION ---
        if (hostname) {
             const checkPath = healthCheckPath || '/';
             const url = `https://${hostname}${checkPath}`;
             stream(`💓 Verifying deployment health at ${url}...`, 'info');
             
             let healthy = false;
             for (let i = 0; i < 5; i++) { // Try for ~25 seconds (5 * 5s)
                 try {
                     const healthRes = await fetch(url).catch(e => {
                         if (e.cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.message.includes('certificate')) {
                             return { ok: true, status: 200, note: "Self-Signed Cert Detected" };
                         }
                         throw e;
                     });

                     if (healthRes.ok || healthRes.status === 404 || healthRes.status === 403 || (healthRes as any).note) {
                         healthy = true;
                         const statusMsg = (healthRes as any).note || healthRes.status;
                         stream(`✅ Health check passed (${statusMsg})`, 'success');
                         break;
                     } else {
                         stream(`Health check pending (${healthRes.status})...`, 'log');
                     }
                 } catch (e) {
                     const errStr = e.message || '';
                     if (errStr.includes('certificate') || errStr.includes('DEPTH_ZERO_SELF_SIGNED_CERT')) {
                         healthy = true;
                         stream(`✅ Health check passed (Self-Signed Cert Detected)`, 'success');
                         break;
                     }
                     stream(`Waiting for DNS propagation...`, 'log');
                 }
                 await new Promise(r => setTimeout(r, 5000));
             }
             
             if (!healthy) {
                 stream(`⚠️ App deployed, but health check failed at ${url}. It might just need more time to boot.`, 'warning');
             }
        }
        
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
