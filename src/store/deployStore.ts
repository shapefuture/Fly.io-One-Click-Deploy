
import { create } from 'zustand';

interface DeployState {
  currentStep: 'input' | 'analyzing' | 'config' | 'deploying' | 'success' | 'error';
  repoUrl: string;
  flyToken: string;
  appName: string;
  region: string;
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
  setInputs: (inputs: Partial<Pick<DeployState, 'repoUrl' | 'flyToken' | 'appName' | 'region'>>) => void;
  setSessionId: (id: string) => void;
  setConfig: (config: DeployState['generatedConfig']) => void;
  addLog: (log: { message: string; type: string }) => void;
  setDeployedUrl: (url: string) => void;
  setError: (error: string) => void;
  reset: () => void;
}

export const useDeployStore = create<DeployState>((set) => ({
  currentStep: 'input',
  repoUrl: '',
  flyToken: '',
  appName: '',
  region: 'iad',
  sessionId: null,
  generatedConfig: null,
  logs: [],
  deployedUrl: null,
  error: null,

  setStep: (step) => set({ currentStep: step }),
  setInputs: (inputs) => set((state) => ({ ...state, ...inputs })),
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
  })
}));
