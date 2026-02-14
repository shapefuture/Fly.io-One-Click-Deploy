import fs from 'fs/promises';
import path from 'path';
import { GoogleGenAI, SchemaType } from "@google/genai";
import OpenAI from 'openai';

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
            return c.slice(12000); // Increased context window slightly
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
                const openai = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: aiConfig.apiKey });
                const completion = await openai.chat.completions.create({
                    model: aiConfig.model || 'google/gemini-2.0-flash-exp:free',
                    messages: [{ role: 'system', content: 'Return JSON object.' }, { role: 'user', content: prompt }],
                    response_format: { type: 'json_object' }
                });
                json = JSON.parse(completion.choices[0].message.content);
            } else {
                const apiKey = aiConfig?.apiKey || process.env.API_KEY;
                const ai = new GoogleGenAI({ apiKey });
                
                // Define Schema for Strict Structured Output
                const schema = {
                    type: SchemaType.OBJECT,
                    properties: {
                        fly_toml: { type: SchemaType.STRING, description: "The complete fly.toml configuration file content." },
                        dockerfile: { type: SchemaType.STRING, nullable: true, description: "The Dockerfile content, or null if existing." },
                        explanation: { type: SchemaType.STRING, description: "Brief explanation of the configuration choices." },
                        stack: { type: SchemaType.STRING, description: "Detected tech stack (e.g., Node.js, Python, Go)." },
                        envVars: {
                            type: SchemaType.ARRAY,
                            items: {
                                type: SchemaType.OBJECT,
                                properties: {
                                    name: { type: SchemaType.STRING },
                                    reason: { type: SchemaType.STRING }
                                },
                                required: ["name", "reason"]
                            }
                        },
                        healthCheckPath: { type: SchemaType.STRING, nullable: true },
                        volumes: {
                            type: SchemaType.ARRAY,
                            description: "List of volumes required by the app.",
                            items: {
                                type: SchemaType.OBJECT,
                                properties: {
                                    name: { type: SchemaType.STRING, description: "Volume name (e.g., 'data')" },
                                    path: { type: SchemaType.STRING, description: "Mount path (e.g., '/data')" }
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
            throw new Error("AI Analysis Failed: " + e.message);
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
