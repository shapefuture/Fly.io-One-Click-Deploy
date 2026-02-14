import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

export const PolicyEngine = {
    /**
     * Applies just-in-time fixes to the deployment directory before build.
     * This acts as a safety net for known configuration edge cases.
     */
    apply: async (targetDir, appName, region, stream) => {
        
        // 1. Antifragile YAML DNS Patching
        // Fixes upstream_dns format for certain proxy configurations if the AI generated malformed YAML.
        const files = await fs.readdir(targetDir);
        for (const file of files) {
            if (file.endsWith('.yaml') || file.endsWith('.yml')) {
                const filePath = path.join(targetDir, file);
                const content = await fs.readFile(filePath, 'utf8');
                
                // Check for raw IP in upstream_dns and wrap in udp:// schema
                if (/upstream_dns:\s*["']?(\d+\.\d+\.\d+\.\d+)["']?/g.test(content)) {
                    stream(`🛡️ Policy: Patching DNS schema in ${file}...`, 'info');
                    const newContent = content.replace(
                        /upstream_dns:\s*["']?(\d+\.\d+\.\d+\.\d+(?::\d+)?)["']?/g, 
                        'upstream_dns: "udp://$1"'
                    );
                    await fs.writeFile(filePath, newContent);
                }
            }
        }

        // 2. Legacy "Config Healer" for Proxy Dockerfiles
        // If Dockerfile expects config.yaml but it's missing, generate a safe default.
        const dockerfilePath = path.join(targetDir, 'Dockerfile');
        if (existsSync(dockerfilePath)) {
            const dockerContent = await fs.readFile(dockerfilePath, 'utf8');
            if (dockerContent.includes('COPY config.yaml')) {
                const configPath = path.join(targetDir, 'config.yaml');
                if (!existsSync(configPath)) {
                    stream("⚠️ Policy: Missing config.yaml detected for Proxy app. Injecting default...", "warning");
                    const emergencyConfig = `general:
  upstream_dns: "udp://1.1.1.1:53"
  bind_http: "0.0.0.0:80"
  bind_https: "0.0.0.0:443"
  public_ipv4: "127.0.0.1"
  log_level: info`;
                    await fs.writeFile(configPath, emergencyConfig);
                }
            }
        }
    }
};
