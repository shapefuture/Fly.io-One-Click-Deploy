import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';

import { TEMP_DIR, VERCEL_HOME, FLY_INSTALL_DIR, IS_VERCEL } from './lib/config.js';
import { getFlyExe } from './lib/installer.js';
import logger from './lib/logger.js';
import { healthCheck } from './controllers/healthController.js';
import { analyzeRepo } from './controllers/analyzeController.js';
import { deployApp } from './controllers/deployController.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
    logger.error('🔥 UNCAUGHT EXCEPTION', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('🔥 UNHANDLED REJECTION', { reason });
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
        if (e.code !== 'EEXIST') logger.error("Init Error", { error: e.message });
    }
}

// Background install
(async () => {
    try {
        await ensureDirs();
        if (!IS_VERCEL) {
             getFlyExe().then(() => logger.info("Flyctl ready")).catch(e => logger.warn("Flyctl install background failed", { error: e.message }));
        }
    } catch (e) {
        logger.error("Startup failure", { error: e.message });
    }
})();

// --- API ROUTES ---

app.get('/api/health', healthCheck);
app.post('/api/analyze', analyzeRepo);
app.post('/api/deploy', deployApp);

if (process.env.NODE_ENV === 'production' && !IS_VERCEL) {
    app.use(express.static(path.join(__dirname, '../dist')));
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));
}

if (!IS_VERCEL) {
    app.listen(port, '0.0.0.0', () => logger.info(`🚀 Server on ${port}`));
}

export default app;