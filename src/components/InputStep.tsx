import { useState } from 'react';
import { useDeployStore } from '../store/deployStore';
import { GlassCard } from './GlassCard';
import { Github, Key, Globe, ArrowRight, Loader2, Info } from 'lucide-react';

export const InputStep = () => {
  const { repoUrl, flyToken, appName, region, setInputs, setStep, setSessionId, setConfig, setError } = useDeployStore();
  const [isLoading, setIsLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const normalizeRepoUrl = (input: string) => {
    const trimmed = input.trim();
    if (trimmed.startsWith('http')) return trimmed;
    if (trimmed.match(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9-._]+$/)) {
      return `https://github.com/${trimmed}`;
    }
    return trimmed;
  };

  const handleAnalyze = async () => {
    setValidationError(null);
    const finalUrl = normalizeRepoUrl(repoUrl);
    
    if (!finalUrl.includes('github.com')) {
        setValidationError("Please enter a valid GitHub repository URL.");
        return;
    }
    
    // Basic Fly token check
    if (!flyToken.startsWith('FlyV1') && !flyToken.startsWith('fo')) {
        setValidationError("That doesn't look like a valid Fly.io Access Token (starts with 'FlyV1' or 'fo').");
        // We warn but don't block, just in case formats change
    }

    if (finalUrl !== repoUrl) setInputs({ repoUrl: finalUrl });

    setIsLoading(true);
    try {
      // Auto-generate app name if empty
      if (!appName) {
        // Create a slug from repo name
        const repoName = finalUrl.split('/').pop()?.replace('.git', '') || 'app';
        const randomSuffix = Math.floor(Math.random() * 10000);
        const name = `${repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${randomSuffix}`;
        setInputs({ appName: name });
      }

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: finalUrl })
      });
      
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Analysis failed');
      
      setSessionId(data.sessionId);
      setConfig({
        fly_toml: data.fly_toml,
        dockerfile: data.dockerfile, // Can be null
        explanation: data.explanation,
        envVars: data.envVars || {},
        stack: data.stack || 'Unknown',
        healthCheckPath: data.healthCheckPath,
        sources: data.sources || []
      });
      setStep('config');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <GlassCard className="w-full max-w-2xl mx-auto space-y-8 animate-fade-in-up">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-white flex items-center gap-2">
          <Github className="w-6 h-6" /> Repository Details
        </h2>
        <p className="text-slate-400">Point us to your code and we'll handle the rest.</p>
      </div>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">GitHub Repository URL</label>
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setInputs({ repoUrl: e.target.value })}
            placeholder="username/repo or https://github.com/..."
            className="w-full bg-black/50 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        <div className="grid md:grid-cols-1 gap-6">
          <div>
            <div className="flex justify-between mb-2">
                <label className="block text-sm font-medium text-slate-300">Fly.io API Token</label>
                <a href="https://fly.io/user/personal_access_tokens" target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline flex items-center gap-1">
                    Get Token <Info className="w-3 h-3" />
                </a>
            </div>
            <div className="relative">
              <Key className="absolute left-3 top-3.5 w-4 h-4 text-slate-500" />
              <input
                type="password"
                value={flyToken}
                onChange={(e) => setInputs({ flyToken: e.target.value })}
                placeholder="FlyV1..."
                className="w-full bg-black/50 border border-white/10 rounded-lg pl-10 pr-4 py-3 text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">App Name (Auto-generated if empty)</label>
            <input
              type="text"
              value={appName}
              onChange={(e) => setInputs({ appName: e.target.value })}
              placeholder="my-awesome-app"
              className="w-full bg-black/50 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Region</label>
            <div className="relative">
              <Globe className="absolute left-3 top-3.5 w-4 h-4 text-slate-500" />
              <select
                value={region}
                onChange={(e) => setInputs({ region: e.target.value })}
                className="w-full bg-black/50 border border-white/10 rounded-lg pl-10 pr-4 py-3 text-white focus:outline-none focus:border-blue-500 appearance-none cursor-pointer"
              >
                <option value="iad">Ashburn (US East)</option>
                <option value="dfw">Dallas (US Central)</option>
                <option value="sjc">San Jose (US West)</option>
                <option value="lhr">London (UK)</option>
                <option value="fra">Frankfurt (EU)</option>
                <option value="nrt">Tokyo (Asia)</option>
                <option value="syd">Sydney (AU)</option>
                <option value="gru">Sao Paulo (SA)</option>
              </select>
            </div>
          </div>
        </div>

        {validationError && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded text-red-200 text-sm flex items-center gap-2">
                <Info className="w-4 h-4" /> {validationError}
            </div>
        )}
      </div>

      <button
        onClick={handleAnalyze}
        disabled={!repoUrl || !flyToken || isLoading}
        className="w-full bg-white text-black font-bold py-4 rounded-lg hover:bg-slate-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isLoading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Analyzing Repository...
          </>
        ) : (
          <>
            Initialize Deployment
            <ArrowRight className="w-5 h-5" />
          </>
        )}
      </button>
    </GlassCard>
  );
};
