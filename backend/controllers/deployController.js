import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';
import toml from '@iarna/toml';
import { TEMP_DIR, VERCEL_HOME, FLY_INSTALL_DIR } from '../lib/config.js';
import { getFlyExe } from '../lib/installer.js';
import { downloadRepo } from '../lib/git.js';
import { PolicyEngine } from '../lib/policy.js';
import logger from '../lib/logger.js';

const isValidAppName = (name) => /^[a-z0-9-]+$/.test(name);
const isValidRepoUrl = (url) => /^https?:\/\/(www\.)?github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-._]+$/.test(url);

const sanitizeLog = (msg) => {
    if (!process.env.FLY_API_TOKEN && !process.env.OPENAI_API_KEY) return msg;
    let clean = msg;
    if (process.env.FLY_API_TOKEN) clean = clean.replace(new RegExp(process.env.FLY_API_TOKEN, 'g'), '[REDACTED_TOKEN]');
    return clean;
};

async function cleanup(dir) {
    if (dir && dir.startsWith(TEMP_DIR)) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

export const deployApp = async (req, res) => {
    const { sessionId, flyToken, flyToml, dockerfile, appName, region, repoUrl, githubToken, preferExistingConfig, files, secrets, healthCheckPath } = req.body;
    
    // Security Validation
    if (!isValidRepoUrl(repoUrl)) return res.write(`data: ${JSON.stringify({ message: "Invalid Repo URL", type: 'error' })}\n\n`);
    if (!isValidAppName(appName)) return res.write(`data: ${JSON.stringify({ message: "Invalid App Name", type: 'error' })}\n\n`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = (msg, type = 'info') => {
        const cleanMsg = sanitizeLog(msg);
        res.write(`data: ${JSON.stringify({ message: cleanMsg, type })}\n\n`);
    };

    const workDir = path.join(TEMP_DIR, sessionId);
    logger.info(`Starting Deployment`, { sessionId, appName });

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

        // --- PRE-FLIGHT CHECKS ---
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
        await PolicyEngine.apply(targetDir, appName, region, stream);

        stream("Registering app...", "info");
        try {
            const createProc = execa(flyExe, ['apps', 'create', appName], { env: DEPLOY_ENV });
            if (createProc.stdout) createProc.stdout.on('data', d => stream(`[Reg] ${d.toString().trim()}`, 'log'));
            await createProc;
        } catch (e) {
            const err = (e.stderr || '') + (e.stdout || '');
            if (err.includes('taken') || err.includes('exists')) stream("App exists, updating...", "warning");
        }
        
        // --- VOLUME PROVISIONING ---
        try {
            let volName = null;
            try {
                const parsedToml = toml.parse(tomlContent);
                if (parsedToml.mounts) {
                    const mountConfig = Array.isArray(parsedToml.mounts) ? parsedToml.mounts[0] : parsedToml.mounts;
                    if (mountConfig && mountConfig.source) {
                        volName = mountConfig.source;
                    }
                }
            } catch (parseErr) {
                const mountsMatch = tomlContent.match(/\[mounts\][\s\S]*?source\s*=\s*['"]?([^'"\s]+)['"]?/);
                if (mountsMatch && mountsMatch[1]) volName = mountsMatch[1];
            }

            if (volName) {
                stream(`📦 Detected Volume Request: '${volName}'`, 'info');
                let volExists = false;
                try {
                    const listProc = await execa(flyExe, ['volumes', 'list', '--json', '--app', appName], { env: DEPLOY_ENV });
                    const vols = JSON.parse(listProc.stdout);
                    if (vols.find(v => v.Name === volName)) volExists = true;
                } catch (e) { }

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
                        stream(`⚠️ Failed to create volume: ${e.message}.`, 'warning');
                    }
                } else {
                    stream(`✅ Volume '${volName}' already exists.`, 'info');
                }
            }
        } catch (e) {
            stream(`⚠️ Volume detection failed: ${e.message}`, 'warning');
        }

        // --- SECRETS ---
        if (secrets && Object.keys(secrets).length > 0) {
            stream("🔐 Configuring secrets...", "info");
            try {
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

        // --- HEALTH VERIFICATION ---
        if (hostname) {
             const checkPath = healthCheckPath || '/';
             const url = `https://${hostname}${checkPath}`;
             stream(`💓 Verifying deployment health at ${url}...`, 'info');
             
             let healthy = false;
             for (let i = 0; i < 5; i++) {
                 try {
                     const healthRes = await fetch(url);
                     if (healthRes.ok) {
                         healthy = true;
                         stream(`✅ Health check passed (${healthRes.status})`, 'success');
                         break;
                     } else {
                         stream(`Health check pending (${healthRes.status})...`, 'log');
                     }
                 } catch (e) {
                     stream(`Waiting for DNS propagation...`, 'log');
                 }
                 await new Promise(r => setTimeout(r, 5000));
             }
             
             if (!healthy) {
                 stream(`⚠️ App deployed, but health check failed at ${url}.`, 'warning');
             }
        }
        
        res.write(`data: ${JSON.stringify({ type: 'success', appUrl: `https://${status.Hostname}`, appName: status.Name })}\n\n`);

    } catch (e) {
        const safeError = sanitizeLog(e.message);
        logger.error('Deployment Failed', { sessionId, error: safeError });
        stream(`Error: ${safeError}`, 'error');
    } finally {
        await cleanup(workDir);
        res.end();
    }
};