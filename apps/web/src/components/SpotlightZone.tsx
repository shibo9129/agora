import { useCallback, type ReactNode } from 'react';

/**
 * Spotlight container: a soft emerald glow follows the mouse across the card
 * (pure CSS variables, one cheap mousemove listener).
 */
export function SpotlightZone({ children, className = '' }: { children: ReactNode; className?: string }) {
  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--spotlight-x', `${e.clientX - rect.left}px`);
    el.style.setProperty('--spotlight-y', `${e.clientY - rect.top}px`);
  }, []);

  return (
    <div className={`spotlight ${className}`} onMouseMove={onMove}>
      {children}
    </div>
  );
}
