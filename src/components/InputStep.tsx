import { useState, useEffect } from 'react';
import { useDeployStore } from '../store/deployStore';
import { GlassCard } from './GlassCard';
import { Github, Key, Globe, ArrowRight, Loader2, Info, Bot, Settings2, RefreshCw, Code, Copy, Check } from 'lucide-react';

const normalizeRepoUrl = (input: string) => {
  const trimmed = input.trim();
  if (trimmed.startsWith('http')) return trimmed;
  if (trimmed.match(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9-._]+$/)) {
    return `https://github.com/${trimmed}`;
  }
  return trimmed;
};

const generateAppNameFromUrl = (url: string) => {
    try {
        const finalUrl = normalizeRepoUrl(url);
        if (!finalUrl.includes('/')) return '';
        
        const repoName = finalUrl.split('/').pop()?.replace('.git', '') || 'app';
        const randomSuffix = Math.floor(Math.random() * 10000);
        return `${repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${randomSuffix}`;
    } catch (e) {
        return '';
    }
};

const BADGE_SVG_URL = "https://raw.githubusercontent.com/shapefuture/bolt.diy/main/flyio-button.svg";

export const InputStep = () => {
  const { repoUrl, flyToken, appName, region, aiConfig, setInputs, setAiConfig, setStep, setSessionId, setConfig, setError } = useDeployStore();
  const [isLoading, setIsLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showBadgeGenerator, setShowBadgeGenerator] = useState(false);
  const [openRouterModels, setOpenRouterModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [copied, setCopied] = useState(false);

  // One-Click Deploy Logic: Parse URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const repoParam = params.get('repo');
    if (repoParam) {
      const generatedName = generateAppNameFromUrl(repoParam);
      setInputs({ 
          repoUrl: repoParam,
          // Only set appName if we managed to generate a valid one
          ...(generatedName ? { appName: generatedName } : {})
      });
    }
  }, [setInputs]);

  const fetchOpenRouterModels = async () => {
    setLoadingModels(true);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      const data = await res.json();
      // Filter for free models (pricing.prompt === "0")
      const freeModels = data.data
        .filter((m: any) => m.pricing?.prompt === "0" && m.pricing?.completion === "0")
        .map((m: any) => m.id)
        .sort();
      
      setOpenRouterModels(freeModels);
      if (!aiConfig.model && freeModels.length > 0) {
        setAiConfig({ model: freeModels[0] });
      }
    } catch (e) {
      console.error("Failed to fetch models", e);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (aiConfig.provider === 'openrouter' && showAiSettings && openRouterModels.length === 0) {
        fetchOpenRouterModels();
    }
  }, [aiConfig.provider, showAiSettings]);

  const handleRepoBlur = () => {
    if (repoUrl && !appName) {
        const generatedName = generateAppNameFromUrl(repoUrl);
        if (generatedName) setInputs({ appName: generatedName });
    }
  };

  const handleAnalyze = async () => {
    setValidationError(null);
    const finalUrl = normalizeRepoUrl(repoUrl);
    
    if (!finalUrl.includes('github.com')) {
        setValidationError("Please enter a valid GitHub repository URL.");
        return;
    }
    
    if (!flyToken.startsWith('FlyV1') && !flyToken.startsWith('fo')) {
        setValidationError("That doesn't look like a valid Fly.io Access Token (starts with 'FlyV1' or 'fo').");
    }

    if (finalUrl !== repoUrl) setInputs({ repoUrl: finalUrl });

    // Validate AI Config if using BYOK
    if (aiConfig.provider === 'openrouter' && !aiConfig.apiKey) {
      setValidationError("OpenRouter API Key is required when OpenRouter provider is selected.");
      return;
    }

    // Final check for app name generation
    let currentAppName = appName;
    if (!currentAppName) {
         currentAppName = generateAppNameFromUrl(finalUrl);
         if (!currentAppName) {
            // Fallback if URL parsing failed somehow
            const randomSuffix = Math.floor(Math.random() * 10000);
            currentAppName = `fly-app-${randomSuffix}`;
         }
         setInputs({ appName: currentAppName });
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          repoUrl: finalUrl,
          aiConfig: {
            ...aiConfig,
            // Don't send empty strings if not set, let backend handle defaults for Gemini
            model: aiConfig.model || undefined
          }
        })
      });
      
      // Robust "RPC-style" error handling
      // We check content-type before parsing to avoid the "Unexpected token T" error
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
          const text = await res.text();
          // Extract meaningful error from HTML if possible, otherwise truncate
          const preview = text.length > 200 ? text.substring(0, 200) + "..." : text;
          throw new Error(`Backend Error (${res.status}): ${preview}`);
      }

      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Analysis failed');
      
      setSessionId(data.sessionId);
      setConfig({
        fly_toml: data.fly_toml,
        dockerfile: data.dockerfile,
        explanation: data.explanation,
        envVars: data.envVars || {},
        stack: data.stack || 'Unknown',
        healthCheckPath: data.healthCheckPath,
        sources: data.sources || []
      });
      setStep('config');
    } catch (err: any) {
      console.error("Analyze Error:", err);
      // Clean up error message for UI
      const msg = err.message.replace(/<[^>]*>/g, ''); // Strip HTML tags if any leaked
      setError(msg || "Failed to analyze repository. The backend service might be unavailable.");
    } finally {
      setIsLoading(false);
    }
  };

  const generateBadgeCode = () => {
    const baseUrl = window.location.origin;
    const targetUrl = repoUrl ? `${baseUrl}?repo=${normalizeRepoUrl(repoUrl)}` : `${baseUrl}?repo=YOUR_GITHUB_URL`;
    return `[![Deploy to Fly.io](${BADGE_SVG_URL})](${targetUrl})`;
  };

  const copyBadge = () => {
    navigator.clipboard.writeText(generateBadgeCode());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <GlassCard className="w-full max-w-2xl mx-auto space-y-8 animate-fade-in-up">
      <div className="flex justify-between items-start">
        <div className="space-y-2">
            <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Github className="w-6 h-6" /> Repository Details
            </h2>
            <p className="text-slate-400">Point us to your code and we'll handle the rest.</p>
        </div>
        <button 
            onClick={() => setShowBadgeGenerator(!showBadgeGenerator)}
            className="text-xs flex items-center gap-1 text-slate-500 hover:text-white transition-colors bg-white/5 px-3 py-1.5 rounded-full border border-white/5"
        >
            <Code className="w-3 h-3" /> Get Badge
        </button>
      </div>

      {showBadgeGenerator && (
         <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl space-y-4 animate-fade-in-up">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-blue-200">One-Click Deploy Button</h3>
                <span className="text-[10px] text-blue-300/60 uppercase tracking-wider">Markdown</span>
            </div>
            
            <div className="flex justify-center py-2">
                <img src={BADGE_SVG_URL} alt="Deploy to Fly.io" className="h-8 hover:scale-105 transition-transform cursor-pointer" title="Preview of the badge" />
            </div>

            <p className="text-xs text-blue-200/70">Add this to your README.md to let others deploy this repo instantly.</p>
            <div className="flex gap-2">
                <code className="flex-1 bg-black/40 text-slate-300 p-3 rounded-lg text-xs font-mono break-all border border-white/5">
                    {generateBadgeCode()}
                </code>
                <button 
                    onClick={copyBadge}
                    className="bg-blue-600 hover:bg-blue-500 text-white px-3 rounded-lg flex items-center justify-center transition-colors"
                >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
            </div>
         </div>
      )}

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">GitHub Repository URL</label>
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setInputs({ repoUrl: e.target.value })}
            onBlur={handleRepoBlur}
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
            <label className="block text-sm font-medium text-slate-300 mb-2">App Name (Auto-generated)</label>
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

        {/* AI Configuration Toggle */}
        <div className="border-t border-white/5 pt-4">
            <button 
                onClick={() => setShowAiSettings(!showAiSettings)}
                className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
            >
                <Settings2 className="w-4 h-4" />
                {showAiSettings ? 'Hide' : 'Show'} Advanced AI Settings (BYOK)
            </button>
            
            {showAiSettings && (
                <div className="mt-4 p-4 bg-white/5 rounded-lg space-y-4 border border-white/5 animate-fade-in-up">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">AI Provider</label>
                        <div className="flex gap-4">
                            <label className={`flex items-center gap-2 cursor-pointer p-3 rounded-lg border transition-all flex-1 ${aiConfig.provider === 'gemini' ? 'bg-blue-500/20 border-blue-500/50 text-white' : 'bg-black/20 border-transparent text-slate-400 hover:bg-white/5'}`}>
                                <input 
                                    type="radio" 
                                    name="provider" 
                                    className="hidden"
                                    checked={aiConfig.provider === 'gemini'}
                                    onChange={() => setAiConfig({ provider: 'gemini' })}
                                />
                                <Bot className="w-4 h-4" /> Gemini (Default)
                            </label>
                            <label className={`flex items-center gap-2 cursor-pointer p-3 rounded-lg border transition-all flex-1 ${aiConfig.provider === 'openrouter' ? 'bg-purple-500/20 border-purple-500/50 text-white' : 'bg-black/20 border-transparent text-slate-400 hover:bg-white/5'}`}>
                                <input 
                                    type="radio" 
                                    name="provider" 
                                    className="hidden"
                                    checked={aiConfig.provider === 'openrouter'}
                                    onChange={() => setAiConfig({ provider: 'openrouter' })}
                                />
                                <Bot className="w-4 h-4" /> OpenRouter
                            </label>
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">
                            {aiConfig.provider === 'gemini' ? 'Gemini API Key (Optional)' : 'OpenRouter API Key'}
                        </label>
                        <input
                            type="password"
                            value={aiConfig.apiKey}
                            onChange={(e) => setAiConfig({ apiKey: e.target.value })}
                            placeholder={aiConfig.provider === 'gemini' ? "Leave empty to use server default" : "sk-or-..."}
                            className="w-full bg-black/50 border border-white/10 rounded-lg px-4 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                        />
                    </div>

                    {aiConfig.provider === 'openrouter' && (
                        <div className="space-y-2">
                             <div className="flex justify-between items-center">
                                <label className="block text-sm font-medium text-slate-300">Model Selection</label>
                                <button onClick={fetchOpenRouterModels} className="text-xs text-blue-400 flex items-center gap-1 hover:text-blue-300">
                                    <RefreshCw className={`w-3 h-3 ${loadingModels ? 'animate-spin' : ''}`} /> Refresh Free Models
                                </button>
                             </div>
                             
                             <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                <select 
                                    value={aiConfig.model} 
                                    onChange={(e) => setAiConfig({ model: e.target.value })}
                                    className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                                >
                                    <option value="">Select a free model...</option>
                                    {openRouterModels.map(m => (
                                        <option key={m} value={m}>{m}</option>
                                    ))}
                                </select>
                                <input 
                                    type="text"
                                    value={aiConfig.model}
                                    onChange={(e) => setAiConfig({ model: e.target.value })}
                                    placeholder="Or type custom model ID..."
                                    className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                                />
                             </div>
                             <p className="text-xs text-slate-500">Select from the dropdown or type any OpenRouter model ID.</p>
                        </div>
                    )}
                </div>
            )}
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