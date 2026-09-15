import { useEffect, useState } from 'react';

export interface ChartTheme {
  axis: string;
  grid: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  legend: string;
}

function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function getChartTheme(): ChartTheme {
  return {
    axis: readVar('--chart-axis', '#5d5d6a'),
    grid: readVar('--chart-grid', 'rgba(255,255,255,0.045)'),
    tooltipBg: readVar('--tooltip-bg', 'rgba(14,14,20,0.94)'),
    tooltipBorder: readVar('--color-edge', 'rgba(255,255,255,0.08)'),
    tooltipText: readVar('--color-ink', '#e4e4e7'),
    legend: readVar('--color-ink-dim', '#71717a'),
  };
}

export function chartTooltipBase(theme: ChartTheme): Record<string, unknown> {
  return {
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    textStyle: { color: theme.tooltipText, fontSize: 12 },
    extraCssText: 'backdrop-filter: blur(10px); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.3);',
  };
}

/** Re-render trigger: flips whenever <html data-theme> changes. */
export function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setTick((t) => t + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return tick;
}
