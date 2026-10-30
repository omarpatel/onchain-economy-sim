"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode, createChart,
  type AutoscaleInfo, type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@econ-sim/sim/snapshot";
import { UI } from "../../lib/palette.ts";

const BASE = {
  layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: UI.muted, fontFamily: "var(--font-mono)", fontSize: 10, attributionLogo: false },
  grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
  rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
  crosshair: { mode: CrosshairMode.Normal },
  timeScale: {
    borderColor: "rgba(255,255,255,0.08)",
    timeVisible: false,
    // the x axis is the sim tick, not wall-clock time
    tickMarkFormatter: (t: UTCTimestamp) => `t${t}`,
  },
  localization: { timeFormatter: (t: UTCTimestamp) => `tick ${t}` },
  handleScale: { axisPressedMouseMove: false },
} as const;

/** Smallest half-range of the price axis as a fraction of mid price, so a 0.5% wiggle isn't drawn as a full-height bar. */
const MIN_HALF_RANGE = 0.02;

/**
 * TradingView candlestick + volume histogram. `candles` are minor-unit OHLCV
 * per tick; `divisor` converts to display units (100 for CR cents).
 */
export function CandleChart({ candles, divisor = 100, height = 200 }: { candles: Candle[]; divisor?: number; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{ candle: ISeriesApi<"Candlestick">; vol: ISeriesApi<"Histogram"> } | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, { ...BASE, height, autoSize: true });
    const candle = c.addSeries(CandlestickSeries, {
      upColor: UI.emerald, downColor: UI.rose, borderVisible: false, wickUpColor: UI.emerald, wickDownColor: UI.rose,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const r = original();
        if (!r?.priceRange) return r;
        const { minValue, maxValue } = r.priceRange;
        const mid = (minValue + maxValue) / 2;
        const half = Math.max((maxValue - minValue) / 2, mid * MIN_HALF_RANGE);
        return { ...r, priceRange: { minValue: mid - half, maxValue: mid + half } };
      },
    });
    // volume is context only: no axis label or price line competing with the last price
    const vol = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", color: "rgba(56,189,248,0.35)", lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.current = c;
    series.current = { candle, vol };
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, [height]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.candle.setData(candles.map((k) => ({ time: k.t as UTCTimestamp, open: k.o / divisor, high: k.h / divisor, low: k.l / divisor, close: k.c / divisor })));
    s.vol.setData(candles.map((k) => ({ time: k.t as UTCTimestamp, value: k.v, color: k.c >= k.o ? "rgba(16,185,129,0.35)" : "rgba(244,63,94,0.35)" })));
    chart.current?.timeScale().scrollToRealTime();
  }, [candles, divisor]);

  return <div ref={el} style={{ height }} className="w-full" />;
}

/** Multi-series line chart for macro series (values already in display units). */
export function LineChart({ series: input, height = 160 }: {
  series: { name: string; color: string; points: { t: number; v: number }[] }[]; height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const lines = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, { ...BASE, height, autoSize: true, rightPriceScale: { ...BASE.rightPriceScale, mode: 0 } });
    chart.current = c;
    return () => { c.remove(); chart.current = null; lines.current = []; };
  }, [height]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    while (lines.current.length < input.length) {
      const idx = lines.current.length;
      lines.current.push(c.addSeries(LineSeries, { color: input[idx].color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: input[idx].name }));
    }
    input.forEach((s, i) => lines.current[i].setData(s.points.map((p) => ({ time: p.t as UTCTimestamp, value: p.v }))));
    c.timeScale().fitContent();
  }, [input]);

  return <div ref={el} style={{ height }} className="w-full" />;
}
