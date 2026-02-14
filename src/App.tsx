import { useDeployStore } from './store/deployStore';
import { InputStep } from './components/InputStep';
import { ConfigStep } from './components/ConfigStep';
import { DeployConsole } from './components/DeployConsole';
import { Plane } from 'lucide-react';

export const App = () => {
  const { currentStep, error } = useDeployStore();

  return (
    <div className="min-h-screen relative flex flex-col">
      {/* Background Ambience */}
      <div className="fixed inset-0 z-[-1] pointer-events-none">
        <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[60%] h-[40%] bg-blue-500/10 rounded-full blur-[100px]" />
        <div className="absolute bottom-0 w-full h-[30%] bg-gradient-to-t from-blue-900/5 to-transparent" />
      </div>

      <header className="pt-12 pb-8 text-center">
        <div className="inline-flex items-center justify-center p-4 mb-6 bg-white/5 rounded-2xl border border-white/10 backdrop-blur-md shadow-xl">
          <Plane className="w-8 h-8 text-white" />
        </div>
        <h1 className="text-4xl md:text-6xl font-bold text-white mb-4 tracking-tight">
          Fly.io <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400">Universal Deployer</span>
        </h1>
        <p className="text-lg text-slate-400 font-light max-w-lg mx-auto">
          AI-orchestrated deployment pipeline. Zero configuration required.
        </p>
      </header>

      <main className="flex-1 container mx-auto px-4 pb-20">
        {error && (
          <div className="max-w-2xl mx-auto mb-8 p-4 bg-red-500/10 border border-red-500/20 text-red-200 rounded-xl text-center">
            Error: {error}
          </div>
        )}

        {currentStep === 'input' && <InputStep />}
        {currentStep === 'config' && <ConfigStep />}
        {(currentStep === 'deploying' || currentStep === 'success' || currentStep === 'error') && <DeployConsole />}
      </main>

      <footer className="py-8 text-center text-slate-600 text-sm border-t border-white/5">
        <p>© {new Date().getFullYear()} Universal Deployer. Powered by OpenAI & Fly.io</p>
      </footer>
    </div>
  );
};