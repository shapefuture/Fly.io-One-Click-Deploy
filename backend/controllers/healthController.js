import { getFlyInstallState } from '../lib/installer.js';
import { IS_VERCEL } from '../lib/config.js';
import logger from '../lib/logger.js';

export const healthCheck = (req, res) => {
    try {
        const installState = getFlyInstallState();
        res.json({ 
            status: 'ok', 
            uptime: process.uptime(), 
            env: IS_VERCEL ? 'vercel' : 'node', 
            flyInstalled: installState.installed,
            installError: installState.error 
        });
    } catch (error) {
        logger.error('Health Check Failed', { error: error.message, stack: error.stack });
        res.status(500).json({ status: 'error', message: error.message });
    }
};