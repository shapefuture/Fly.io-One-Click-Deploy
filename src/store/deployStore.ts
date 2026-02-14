import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface DeployState {
  currentStep: 'input' | 'analyzing' | 'config' | 'deploying' | 'success' | 'error';
  repoUrl: string;
  flyToken: string;
  githubToken: string;
  preferExistingConfig: boolean;
  appName: string;
  region: string;
  
  // AI Configuration
  aiConfig: {
    provider: 'gemini' | 'openrouter';
    apiKey: string;
    model: string;
  };

  sessionId: string | null;
  generatedConfig: {
    fly_toml: string;
    dockerfile: string | null;
    explanation: string;
    envVars: Record<string, string>;
    stack: string;
    healthCheckPath?: string;
    sources: Array<{ title: string; uri: string }>;
  } | null;
  logs: Array<{ message: string; type: 'info' | 'log' | 'error' | 'success' | 'warning' }>;
  deployedUrl: string | null;
  error: string | null;

  setStep: (step: DeployState['currentStep']) => void;
  setInputs: (inputs: Partial<Pick<DeployState, 'repoUrl' | 'flyToken' | 'appName' | 'region' | 'githubToken' | 'preferExistingConfig'>>) => void;
  setAiConfig: (config: Partial<DeployState['aiConfig']>) => void;
  setSessionId: (id: string) => void;
  setConfig: (config: DeployState['generatedConfig']) => void;
  addLog: (log: { message: string; type: string }) => void;
  setDeployedUrl: (url: string) => void;
  setError: (error: string) => void;
  reset: () => void;
  
  deployApp: () => Promise<void>;
}

export const useDeployStore = create<DeployState>()(
  persist(
    (set, get) => ({
      currentStep: 'input',
      repoUrl: '',
      flyToken: '',
      githubToken: '',
      preferExistingConfig: false,
      appName: '',
      region: 'iad',
      
      aiConfig: {
        provider: 'gemini',
        apiKey: '',
        model: ''
      },

      sessionId: null,
      generatedConfig: null,
      logs: [],
      deployedUrl: null,
      error: null,

      setStep: (step) => set({ currentStep: step }),
      setInputs: (inputs) => set((state) => ({ ...state, ...inputs })),
      setAiConfig: (config) => set((state) => ({ aiConfig: { ...state.aiConfig, ...config } })),
      setSessionId: (id) => set({ sessionId: id }),
      setConfig: (config) => set({ generatedConfig: config }),
      addLog: (log) => set((state) => ({ logs: [...state.logs, { ...log, type: log.type as any }] })),
      setDeployedUrl: (url) => set({ deployedUrl: url }),
      setError: (error) => set({ error, currentStep: 'error' }),
      reset: () => set({
        currentStep: 'input',
        sessionId: null,
        generatedConfig: null,
        logs: [],
        deployedUrl: null,
        error: null
      }),

      deployApp: async () => {
        const { sessionId, flyToken, appName, region, repoUrl, githubToken, preferExistingConfig, generatedConfig } = get();
        
        set({ currentStep: 'deploying', error: null, logs: [], deployedUrl: null });

        try {
          const response = await fetch('/api/deploy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId, flyToken, appName, region, repoUrl, githubToken, preferExistingConfig,
              flyToml: generatedConfig?.fly_toml,
              dockerfile: generatedConfig?.dockerfile
            })
          });

          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          if (!reader) throw new Error("Failed to stream logs");

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.type === 'success') {
                        set({ deployedUrl: data.appUrl, currentStep: 'success' });
                        return;
                    } else {
                        get().addLog({ message: data.message, type: data.type });
                    }
                } catch (e) { console.error("Parse error on chunk", line); }
              }
            }
          }
        } catch (e: any) {
            get().addLog({ message: `Fatal error: ${e.message}`, type: 'error' });
            set({ error: e.message, currentStep: 'error' });
        }
      }
    }),
    {
      name: 'deploy-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        repoUrl: state.repoUrl,
        flyToken: state.flyToken,
        githubToken: state.githubToken,
        preferExistingConfig: state.preferExistingConfig,
        appName: state.appName,
        region: state.region,
        aiConfig: state.aiConfig
      }),
    }
  )
);