import fs from 'fs/promises';
import path from 'path';

// DYNAMIC IMPORT STRATEGY: 
// We do NOT import @google/genai or openai at the top level.
// This prevents the entire backend server from crashing on startup if 
// the AI packages are missing, have version mismatches, or if 'Type' is undefined.

export const AIStrategy = {
    name: "AIStrategy",

    detect: () => true, // Fallback strategy

    analyze: async (repoPath, repoUrl, appName, aiConfig, preferExistingConfig) => {
        
        const context = await (async () => {
            const files = ['package.json', 'fly.toml', 'Dockerfile', 'requirements.txt', 'go.mod', 'prisma/schema.prisma', 'config.yml'];
            let c = "";
            for (const f of files) {
                try { c += `\n${f}:\n` + await fs.readFile(path.join(repoPath, f), 'utf8'); } catch {}
            }
            return c.slice(12000);
        })();

        const hasDockerfile = context.includes("Dockerfile:");

        if (preferExistingConfig && context.includes("fly.toml:")) {
             return {
                fly_toml: "# Existing config will be used",
                dockerfile: null,
                explanation: "Using existing configuration found in repository.",
                envVars: {},
                stack: "Existing Config",
                files: []
            };
        }

        const prompt = `DevOps Task: Config for Fly.io. Repo: ${repoUrl}. Context: ${context}.
        
        GOAL: Generate a production-ready 'fly.toml' and 'Dockerfile' (if needed).
        
        CRITICAL RULES:
        1. fly.toml: Use SINGLE QUOTES for strings.
        2. Resources: [[vm]] MUST have memory='1gb' AND memory_mb=1024.
        3. Dockerfile: If one exists in context, return null. If generating, use JSON array syntax for CMD.
        4. Ports: Detect 'internal_port' (8080, 3000, 80).
        5. Persistence: If the app needs a database (SQLite) or file uploads, define [mounts] in fly.toml and list it in the 'volumes' array.
        6. Persistence Policy: Set auto_stop_machines = false and min_machines_running = 1.
        
        PREFERRED FLY.TOML STRUCTURE:
        app = '${appName || 'name'}'
        primary_region = 'iad'
        [http_service]
          internal_port = 8080
          force_https = true
          auto_stop_machines = false
          auto_start_machines = true
          min_machines_running = 1
        [[vm]]
          memory = '1gb'
          cpu_kind = 'shared'
          cpus = 1
          memory_mb = 1024
        [mounts] (ONLY IF NEEDED)
          source = 'data'
          destination = '/data'
        `;

        const provider = aiConfig?.provider || 'gemini';
        let json;

        try {
            if (provider === 'openrouter') {
                // Dynamic import for OpenAI
                const { default: OpenAI } = await import('openai');
                
                const openai = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: aiConfig.apiKey });
                const completion = await openai.chat.completions.create({
                    model: aiConfig.model || 'google/gemini-2.0-flash-exp:free',
                    messages: [{ role: 'system', content: 'Return JSON object.' }, { role: 'user', content: prompt }],
                    response_format: { type: 'json_object' }
                });
                json = JSON.parse(completion.choices[0].message.content);
            } else {
                const apiKey = aiConfig?.apiKey || process.env.API_KEY;
                if (!apiKey) throw new Error("API Key missing");
                
                // Dynamic import for GoogleGenAI
                const { GoogleGenAI, Type } = await import("@google/genai");
                
                const ai = new GoogleGenAI({ apiKey });
                
                // Use Type from @google/genai as required
                const schema = {
                    type: Type.OBJECT,
                    properties: {
                        fly_toml: { type: Type.STRING, description: "The complete fly.toml configuration file content." },
                        dockerfile: { type: Type.STRING, nullable: true, description: "The Dockerfile content, or null if existing." },
                        explanation: { type: Type.STRING, description: "Brief explanation of the configuration choices." },
                        stack: { type: Type.STRING, description: "Detected tech stack (e.g., Node.js, Python, Go)." },
                        envVars: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING },
                                    reason: { type: Type.STRING }
                                },
                                required: ["name", "reason"]
                            }
                        },
                        healthCheckPath: { type: Type.STRING, nullable: true },
                        volumes: {
                            type: Type.ARRAY,
                            description: "List of volumes required by the app.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING, description: "Volume name (e.g., 'data')" },
                                    path: { type: Type.STRING, description: "Mount path (e.g., '/data')" }
                                },
                                required: ["name", "path"]
                            }
                        }
                    },
                    required: ["fly_toml", "explanation", "stack", "envVars"]
                };

                const result = await ai.models.generateContent({
                    model: aiConfig?.model || 'gemini-2.0-flash',
                    contents: prompt,
                    config: { 
                        responseMimeType: "application/json",
                        responseSchema: schema
                    }
                });
                
                json = JSON.parse(result.text);
            }
        } catch (e) {
            console.error("AI Generation Error:", e);
            throw new Error(`AI Analysis Failed: ${e.message} (Check backend logs for details)`);
        }

        if (hasDockerfile) json.dockerfile = null;

        return {
            fly_toml: json.fly_toml,
            dockerfile: json.dockerfile,
            explanation: json.explanation,
            envVars: json.envVars,
            stack: json.stack || 'Auto-Detected',
            healthCheckPath: json.healthCheckPath,
            volumes: json.volumes || [],
            files: []
        };
    }
};
