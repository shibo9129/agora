import { useEffect, useRef, useState } from 'react';

/** Animate a number from 0 → target with expo ease-out.
 *  Honors prefers-reduced-motion (accessibility): renders the final value
 *  immediately instead of animating. */
export function useCountUp(target: number, durationMs = 700): number {
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [value, setValue] = useState(reduceMotion ? target : 0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (reduceMotion) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutExpo
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setValue(target * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, durationMs, reduceMotion]);

  return value;
}
