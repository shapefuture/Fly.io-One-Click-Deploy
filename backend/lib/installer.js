import { execa } from 'execa';
import fs from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { IS_WINDOWS, IS_VERCEL, BIN_NAME, VERCEL_HOME, FLY_INSTALL_DIR, FLY_BIN } from './config.js';

const require = createRequire(import.meta.url);

// Robust Require for CJS deps
let AdmZip, tar;
try {
    AdmZip = require('adm-zip');
    tar = require('tar');
} catch (e) {
    console.warn("⚠️ Critical Dependency Missing:", e.message);
}

let flyBinPath = null;
let installationPromise = null;
let lastInstallError = null;

// Hardened Security: Pinned Version
const PINNED_VERSION = "0.2.22";

// TODO: Populate with real checksums for strict security mode
const CHECKSUMS = {
    // "filename": "sha256_hash"
};

async function verifyChecksum(filePath, fileName) {
    if (!CHECKSUMS[fileName]) {
        return true;
    }
    
    try {
        const fileBuffer = await fs.readFile(filePath);
        const hash = createHash('sha256').update(fileBuffer).digest('hex');
        
        if (hash !== CHECKSUMS[fileName]) {
            console.error(`[Security] Checksum Mismatch! Expected ${CHECKSUMS[fileName]}, got ${hash}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error(`[Security] Verification failed: ${e.message}`);
        return false;
    }
}

async function performAntifragileInstallation() {
    const log = (msg) => console.log(`[FlyInstaller] ${msg}`);
    const warn = (msg) => console.warn(`[FlyInstaller] ${msg}`);

    if (!AdmZip || !tar) throw new Error("Missing required dependencies (adm-zip or tar)");

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

    // Strategy 1: Direct Pinned Download (Hardened)
    log(`Strategy 1: Direct Download (Pinned v${PINNED_VERSION})`);
    try {
        const platform = os.platform();
        const arch = os.arch();
        let osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
        let archName = (arch === 'arm64') ? 'arm64' : (arch === 'x64' ? 'x86_64' : arch);

        const fileExts = platform === 'win32' ? ['.zip'] : ['.tar.gz'];
        
        for (const ext of fileExts) {
            const fileName = `flyctl_${PINNED_VERSION}_${osName}_${archName}${ext}`;
            const url = `https://github.com/superfly/flyctl/releases/download/v${PINNED_VERSION}/${fileName}`;
            
            try {
                const tmpPath = path.join(VERCEL_HOME, `fly_dl_${uuidv4()}${ext}`);
                log(`Downloading from ${url}...`);
                
                // Fetch availability check
                if (typeof fetch === 'undefined') {
                     throw new Error("Global fetch is unavailable. Node 18+ required.");
                }

                const response = await fetch(url);
                if (!response.ok) {
                    warn(`Failed to download ${fileName}: ${response.status}`);
                    continue;
                }

                const fileStream = createWriteStream(tmpPath);
                await pipeline(response.body, fileStream);

                // Security Check
                if (!(await verifyChecksum(tmpPath, fileName))) {
                     throw new Error("Checksum verification failed. Aborting installation.");
                }

                if (ext === '.zip') {
                    new AdmZip(tmpPath).extractAllTo(binDir, true);
                } else {
                    await tar.x({ file: tmpPath, cwd: binDir });
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
                            log(`✅ Successfully installed v${PINNED_VERSION}`);
                            return FLY_BIN;
                        }
                }
            } catch (dlErr) {
                warn(`Download error: ${dlErr.message}`);
            }
        }
    } catch (e) { warn(`Strategy 1 failed: ${e.message}`); }
    
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