import { execa } from 'execa';
import fs from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';
import { IS_WINDOWS, IS_VERCEL, BIN_NAME, VERCEL_HOME, FLY_INSTALL_DIR, FLY_BIN } from './config.js';

const require = createRequire(import.meta.url);

let flyBinPath = null;
let installationPromise = null;
let lastInstallError = null;

async function performAntifragileInstallation() {
    const log = (msg) => console.log(`[FlyInstaller] ${msg}`);
    const warn = (msg) => console.warn(`[FlyInstaller] ${msg}`);

    // Lazy load dependencies to ensure server starts even if they are missing
    let AdmZip, tar;
    try {
        AdmZip = require('adm-zip');
    } catch (e) {
        throw new Error("Missing 'adm-zip'. Please run npm install.");
    }
    
    try {
        tar = require('tar');
    } catch (e) {
        warn("'tar' npm package missing. Will fall back to system tar.");
    }

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
            log("Strategy 1: curl | sh");
            await execa('sh', ['-c', 'curl -L https://fly.io/install.sh | sh'], {
                env: CHILD_ENV,
                timeout: 45000
            });
            if (await verify(FLY_BIN)) return FLY_BIN;
        } catch (e) { }

        try {
            log("Strategy 1b: wget | sh");
            await execa('sh', ['-c', 'wget -qO- https://fly.io/install.sh | sh'], {
                env: CHILD_ENV,
                timeout: 45000
            });
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
        } catch (e) { warn("GitHub API failed, skipping latest version check."); }

        versionsToTry.push("0.4.11");
        versionsToTry.push("0.2.22");
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
    } catch (e) { warn(`Strategy 2 Matrix failed: ${e.message}`); }
    throw new Error(`Installation failed.`);
}

export async function getFlyExe() {
    if (flyBinPath && existsSync(flyBinPath)) return flyBinPath;
    if (!installationPromise) {
        installationPromise = performAntifragileInstallation()
            .then(p => { flyBinPath = p; installationPromise = null; return p; })
            .catch(e => { lastInstallError = e.message; installationPromise = null; throw e; });
    }
    return installationPromise;
}

export function getFlyInstallState() {
    return { installed: !!flyBinPath, error: lastInstallError };
}
