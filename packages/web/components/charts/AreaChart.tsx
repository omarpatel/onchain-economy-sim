"use client";

import { useEffect, useRef } from "react";
import { AreaSeries, ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { UI } from "../../lib/palette.ts";

/** "#rrggbb" → "rgba(r,g,b,a)" for the gradient fill stops. */
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Single-series area chart (mint line + vertical gradient fill) over sim
 * ticks; `points[].v` are already display units. No grid, no axis borders.
 */
export function AreaChart({ points, height = 150, color = "#3ddc97" }: { points: { t: number; v: number }[]; height?: number; color?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: UI.muted, fontFamily: "var(--font-mono)", fontSize: 10, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.05 } },
      timeScale: { borderVisible: false, timeVisible: false, tickMarkFormatter: (t: UTCTimestamp) => `t${t}` },
      localization: { timeFormatter: (t: UTCTimestamp) => `tick ${t}` },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "rgba(255,255,255,0.18)", style: LineStyle.Solid, width: 1, labelBackgroundColor: "#26262b" },
        horzLine: { color: "rgba(255,255,255,0.18)", style: LineStyle.Solid, width: 1, labelBackgroundColor: "#26262b" },
      },
      handleScale: { axisPressedMouseMove: false },
    });
    series.current = c.addSeries(AreaSeries, {
      lineColor: color,
      lineWidth: 2,
      topColor: rgba(color, 0.35),
      bottomColor: rgba(color, 0),
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
    });
    chart.current = c;
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, [height, color]);

  useEffect(() => {
    if (!series.current) return;
    series.current.setData(points.map((p) => ({ time: p.t as UTCTimestamp, value: p.v })));
    chart.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={el} style={{ height }} className="w-full" />;
}
