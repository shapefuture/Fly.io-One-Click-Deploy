import React from 'react';
import { cn } from '../utils/cn';

interface GlassCardProps {
  children?: React.ReactNode;
  className?: string;
}

export const GlassCard = ({ children, className }: GlassCardProps) => {
  return (
    <div className={cn(
      "bg-black/40 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-6 md:p-8",
      className
    )}>
      {children}
    </div>
  );
};