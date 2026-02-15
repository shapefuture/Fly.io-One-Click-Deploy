import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { TEMP_DIR } from '../lib/config.js';
import { downloadRepo } from '../lib/git.js';
import { StackDetector } from '../lib/stack-detector.js';
import logger from '../lib/logger.js';

const isValidAppName = (name) => /^[a-z0-9-]+$/.test(name);
const isValidRepoUrl = (url) => /^https?:\/\/(www\.)?github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-._]+$/.test(url);

export const analyzeRepo = async (req, res) => {
    const { repoUrl, aiConfig, githubToken, preferExistingConfig, appName } = req.body;
    
    // Security Validation
    if (!isValidRepoUrl(repoUrl)) {
        return res.status(400).json({ error: "Invalid GitHub Repository URL" });
    }
    if (appName && !isValidAppName(appName)) {
        return res.status(400).json({ error: "Invalid App Name. Use lowercase letters, numbers, and hyphens only." });
    }

    const sessionId = uuidv4();
    const workDir = path.join(TEMP_DIR, sessionId);
    await fs.mkdir(workDir, { recursive: true }).catch(() => {});

    logger.info(`Starting Analysis for ${repoUrl}`, { sessionId, appName });

    try {
        // 1. Download Repo
        let repoPath = workDir;
        try { 
            repoPath = await downloadRepo(repoUrl, workDir, githubToken); 
        } catch (e) { 
            logger.warn('Repo Download Warning', { sessionId, error: e.message });
        }

        // 2. Detect Strategy
        const strategy = StackDetector.detect(repoPath, repoUrl);
        logger.info(`Strategy Detected`, { sessionId, strategy: strategy.name });

        // 3. Execute Strategy
        const result = await strategy.analyze(repoPath, repoUrl, appName, aiConfig, preferExistingConfig);

        // 4. Global Post-Processing
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
        logger.error("Analysis Failed", { sessionId, error: e.message, stack: e.stack });
        res.status(500).json({ error: e.message });
    }
};