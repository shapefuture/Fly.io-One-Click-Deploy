import { useDeployStore } from '../store/deployStore';
import { GlassCard } from './GlassCard';
import { FileCode, Rocket, ArrowLeft, Cpu, ShieldAlert, Globe, Link as LinkIcon, Database, Activity, Download } from 'lucide-react';

export const ConfigStep = () => {
  const { generatedConfig, setConfig, setStep, sessionId, flyToken, appName, region, addLog, setDeployedUrl, setStep: setAppStep } = useDeployStore();

  const handleDeploy = async () => {
    setAppStep('deploying');
    try {
      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId, flyToken, appName, region,
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
                    setDeployedUrl(data.appUrl);
                    setAppStep('success');
                    return;
                } else {
                    addLog({ message: data.message, type: data.type });
                }
            } catch (e) { console.error("Parse error on chunk", line); }
          }
        }
      }
    } catch (e: any) {
        addLog({ message: `Fatal error: ${e.message}`, type: 'error' });
    }
  };

  const downloadConfig = () => {
    if (!generatedConfig) return;
    const blob = new Blob([generatedConfig.fly_toml], { type: 'text/toml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fly.toml';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!generatedConfig) return null;

  return (
    <div className="w-full max-w-7xl mx-auto space-y-8 animate-fade-in-up">
      <div className="flex items-center justify-between">
        <button onClick={() => setStep('input')} className="text-slate-400 hover:text-white flex items-center gap-2 transition-colors group">
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" /> Back to Inputs
        </button>
        <div className="flex items-center gap-3">
            <span className="px-3 py-1 bg-green-500/10 text-green-400 rounded-full text-xs font-bold uppercase tracking-wider border border-green-500/20">
                Analysis Complete
            </span>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        {/* Intelligence Sidebar */}
        <div className="lg:col-span-1 space-y-6">
          <GlassCard className="border-blue-500/20">
            <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <Cpu className="w-5 h-5 text-blue-400" /> Stack Analysis
            </h3>
            <div className="space-y-4">
                <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">Detected Framework</p>
                    <p className="text-sm text-blue-300 font-medium">{generatedConfig.stack || "Unknown Stack"}</p>
                </div>
                <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">Deployment Strategy</p>
                    <p className="text-sm text-slate-300">
                        {generatedConfig.dockerfile ? "Custom Multi-Stage Build" : "Pre-existing Dockerfile"}
                    </p>
                </div>
                {generatedConfig.healthCheckPath && (
                   <div className="p-3 bg-white/5 rounded-lg border border-white/5 flex items-start gap-3">
                      <Activity className="w-4 h-4 text-green-400 mt-1 shrink-0" />
                      <div>
                          <p className="text-xs text-slate-500 uppercase font-bold mb-1">Health Check</p>
                          <code className="text-sm text-green-300 font-mono">{generatedConfig.healthCheckPath}</code>
                      </div>
                   </div>
                )}
                <p className="text-sm text-slate-400 leading-relaxed italic border-l-2 border-blue-500/30 pl-3">
                    "{generatedConfig.explanation}"
                </p>
            </div>
          </GlassCard>

          <GlassCard className="border-purple-500/20">
            <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-purple-400" /> Secrets & Env
            </h3>
            <div className="space-y-3">
                {Object.keys(generatedConfig.envVars).length > 0 ? (
                    Object.entries(generatedConfig.envVars).map(([key, desc]) => (
                        <div key={key} className="group p-3 bg-slate-900/50 rounded-lg border border-slate-800 hover:border-purple-500/30 transition-all">
                            <div className="flex items-center justify-between mb-1">
                                <code className="text-purple-300 text-xs font-bold font-mono truncate max-w-[150px]">{key}</code>
                                <Database className="w-3 h-3 text-slate-600 group-hover:text-purple-400 transition-colors" />
                            </div>
                            <p className="text-[11px] text-slate-500 leading-tight">{desc}</p>
                        </div>
                    ))
                ) : (
                    <p className="text-sm text-slate-500 italic">No specific env variables identified.</p>
                )}
            </div>
            <div className="mt-4 pt-4 border-t border-white/5">
                <p className="text-xs text-slate-500">
                    Run <code className="bg-slate-800 px-1 rounded">fly secrets set KEY=VALUE</code> after deployment.
                </p>
            </div>
          </GlassCard>

          {generatedConfig.sources && generatedConfig.sources.length > 0 && (
            <GlassCard>
                <h3 className="text-sm font-bold text-slate-500 uppercase mb-4 tracking-widest">Reference Docs</h3>
                <div className="flex flex-col gap-2">
                    {generatedConfig.sources.map((s, i) => (
                        <a key={i} href={s.uri} target="_blank" rel="noreferrer" className="text-xs flex items-center gap-2 text-slate-400 hover:text-blue-400 transition-colors">
                            <LinkIcon className="w-3 h-3" /> {s.title}
                        </a>
                    ))}
                </div>
            </GlassCard>
          )}
        </div>

        {/* Configuration Main Editors */}
        <div className="lg:col-span-2 space-y-6">
          <div className="grid grid-cols-1 gap-6">
            <GlassCard className="flex flex-col h-[500px] p-0 overflow-hidden border-white/5">
                <div className="bg-white/5 px-6 py-3 flex items-center justify-between border-b border-white/5">
                    <div className="flex items-center gap-2 text-sm text-slate-300 font-mono">
                        <FileCode className="w-4 h-4 text-blue-400" /> fly.toml
                    </div>
                    <div className="flex items-center gap-2">
                         <button onClick={downloadConfig} className="text-[10px] text-slate-400 hover:text-white flex items-center gap-1 uppercase tracking-wide px-2 py-1 rounded hover:bg-white/5 transition-colors">
                            <Download className="w-3 h-3" /> Download
                         </button>
                        <span className="text-[10px] text-slate-600 font-mono uppercase px-2">Primary Config</span>
                    </div>
                </div>
                <div className="relative flex-1">
                    <textarea
                        value={generatedConfig.fly_toml}
                        onChange={(e) => setConfig({ ...generatedConfig, fly_toml: e.target.value })}
                        className="absolute inset-0 w-full h-full bg-[#0d1117] text-blue-100 font-mono text-sm p-6 focus:outline-none resize-none selection:bg-blue-500/30 leading-relaxed"
                        spellCheck={false}
                    />
                </div>
            </GlassCard>

            <GlassCard className="flex flex-col h-[500px] p-0 overflow-hidden border-white/5">
                <div className="bg-white/5 px-6 py-3 flex items-center justify-between border-b border-white/5">
                    <div className="flex items-center gap-2 text-sm text-slate-300 font-mono">
                        <Globe className="w-4 h-4 text-green-400" /> Dockerfile
                    </div>
                    <span className="text-[10px] text-slate-600 font-mono uppercase">
                        {generatedConfig.dockerfile ? "AI Generated" : "Detected in Repository"}
                    </span>
                </div>
                {generatedConfig.dockerfile ? (
                     <div className="relative flex-1">
                        <textarea
                            value={generatedConfig.dockerfile}
                            onChange={(e) => setConfig({ ...generatedConfig, dockerfile: e.target.value })}
                            className="absolute inset-0 w-full h-full bg-[#0d1117] text-green-100 font-mono text-sm p-6 focus:outline-none resize-none selection:bg-green-500/30 leading-relaxed"
                            spellCheck={false}
                        />
                    </div>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-black/20">
                        <div className="w-16 h-16 rounded-full bg-slate-800/50 flex items-center justify-center mb-4 border border-white/5">
                            <FileCode className="w-8 h-8 text-slate-500" />
                        </div>
                        <p className="text-slate-300 font-medium">Using Existing Dockerfile</p>
                        <p className="text-slate-500 text-sm max-w-sm mt-2">
                            The repository already contains a Dockerfile, so we'll use that for the build process.
                        </p>
                    </div>
                )}
            </GlassCard>
          </div>

          <div className="flex justify-end gap-4 pt-4 border-t border-white/5">
            <button
                onClick={handleDeploy}
                className="group relative bg-white text-black px-12 py-4 rounded-xl font-bold text-lg overflow-hidden transition-all hover:bg-blue-50 hover:scale-[1.02] active:scale-[0.98] shadow-2xl shadow-blue-500/20"
            >
                <div className="absolute inset-0 bg-gradient-to-r from-blue-400/20 to-indigo-400/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                <span className="relative flex items-center gap-3">
                    <Rocket className="w-5 h-5 group-hover:-translate-y-1 group-hover:translate-x-1 transition-transform" />
                    Launch to Fly.io
                </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
