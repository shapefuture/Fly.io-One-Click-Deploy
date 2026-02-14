import { useEffect, useRef } from 'react';
import { useDeployStore } from '../store/deployStore';
import { Terminal, Loader2, CheckCircle2, ExternalLink, AlertTriangle } from 'lucide-react';

export const DeployConsole = () => {
  const { logs, currentStep, deployedUrl, error } = useDeployStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const getLogStyle = (log: { message: string, type: string }) => {
    if (log.type === 'error') return 'text-red-400 bg-red-900/10 border-l-2 border-red-500 pl-2 py-1 my-1';
    if (log.type === 'warning') return 'text-yellow-400 bg-yellow-900/10 border-l-2 border-yellow-500 pl-2 py-1 my-1';
    if (log.type === 'success') return 'text-green-400 font-bold bg-green-900/10 border-l-2 border-green-500 pl-2 py-1 my-1';
    if (log.type === 'info') return 'text-blue-300 font-semibold mt-2 border-l-2 border-blue-500 pl-2';
    
    // Heuristic styling for raw flyctl logs
    const msg = log.message;
    if (msg.includes('Step') || msg.match(/^\[\d+\/\d+\]/)) return 'text-cyan-300 font-bold mt-1'; // Build steps
    if (msg.includes('Waiting for remote builder')) return 'text-purple-300 italic';
    if (msg.match(/v\d+ deployed successfully/)) return 'text-green-400 font-bold';
    if (msg.includes('Pushing image')) return 'text-slate-400';
    
    return 'text-slate-300 font-mono opacity-90';
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6 animate-fade-in-up">
      <div className="flex items-center justify-between text-white">
        <h2 className="text-2xl font-bold flex items-center gap-3">
          {currentStep === 'deploying' ? (
            <>
              <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400">
                Orchestrating Deployment
              </span>
            </>
          ) : currentStep === 'error' ? (
             <>
              <AlertTriangle className="w-6 h-6 text-red-400" />
              Deployment Failed
            </>
          ) : (
            <>
              <CheckCircle2 className="w-6 h-6 text-green-400" />
              Mission Accomplished
            </>
          )}
        </h2>
        {deployedUrl && (
          <a
            href={deployedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 bg-green-500 text-black font-bold px-6 py-2 rounded-lg hover:bg-green-400 transition-all shadow-lg shadow-green-500/20"
          >
            Open Live App <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </div>

      <div className="rounded-xl overflow-hidden bg-[#0a0a0a] border border-white/10 shadow-2xl font-mono text-sm relative">
        <div className="bg-[#1a1a1a] px-4 py-2 flex items-center justify-between border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500/20 hover:bg-red-500 transition-colors" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/20 hover:bg-yellow-500 transition-colors" />
                <div className="w-3 h-3 rounded-full bg-green-500/20 hover:bg-green-500 transition-colors" />
            </div>
            <span className="ml-3 text-slate-500 text-xs flex items-center gap-2 border-l border-white/10 pl-3">
                <Terminal className="w-3 h-3" /> 
                Deployment Stream
            </span>
          </div>
          {currentStep === 'deploying' && (
              <span className="text-[10px] text-blue-400 animate-pulse uppercase tracking-wider">Live</span>
          )}
        </div>
        
        <div 
          ref={scrollRef}
          className="h-[600px] overflow-y-auto p-6 space-y-1 font-mono text-xs md:text-sm scroll-smooth"
        >
          {logs.map((log, i) => (
            <div key={i} className={`break-words transition-all duration-300 ${getLogStyle(log)}`}>
              {log.type === 'log' && !log.message.includes('Step') && (
                  <span className="inline-block w-2 h-2 mr-2 opacity-20 select-none">›</span>
              )}
              {log.message}
            </div>
          ))}
          
          {currentStep === 'deploying' && (
            <div className="animate-pulse text-blue-500 mt-2 pl-4">_</div>
          )}

          {error && (
              <div className="mt-4 p-4 bg-red-500/10 border border-red-500/20 rounded text-red-300">
                  <strong>Critical Error:</strong> {error}
                  <div className="mt-2 text-xs text-red-400/70">
                      Common fixes: Check your Fly.io token permissions, ensure app name is unique, or verify credit card on file for remote builders.
                  </div>
              </div>
          )}
        </div>
      </div>
    </div>
  );
};