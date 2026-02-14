import { ProxyStrategy } from '../strategies/proxy.js';
import { AIStrategy } from '../strategies/ai.js';

export const StackDetector = {
    detect: (repoPath, repoUrl) => {
        const strategies = [ProxyStrategy];
        
        for (const strategy of strategies) {
            if (strategy.detect(repoPath, repoUrl)) {
                return strategy;
            }
        }
        
        return AIStrategy;
    }
};
