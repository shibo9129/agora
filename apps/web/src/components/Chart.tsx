import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, TreemapChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  TreemapChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  TitleComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

export function Chart({ option, className, onSelect }: { option: EChartsCoreOption; className?: string; onSelect?: (path: string, kind?: string) => void }) {
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.on('click', (event: unknown) => {
      const data = (event as { data?: { path?: string; kind?: string } }).data;
      if (data?.path !== undefined) selectRef.current?.(data.path, data.kind);
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} className={className ?? 'h-64 w-full'} />;
}
