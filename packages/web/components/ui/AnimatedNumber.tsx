"use client";

import { useEffect, useRef } from "react";
import { UI } from "../../lib/palette.ts";

const TWEEN_MS = 400;
/** Shorter than a sim tick (800 ms) so a ticking balance pulses instead of glowing constantly. */
const FLASH_MS = 500;
const UP = UI.mintBright;
const DOWN = "#fb7185";

/**
 * A number that counts to each new value over ~400 ms and flashes mint
 * (up) or rose (down). The text node is written through a ref, so the tween
 * never re-renders React; React only ever renders the first value. A new
 * value mid-tween continues from what is on screen. `prefers-reduced-motion`
 * snaps to the value (the colour flash stays: it is not motion).
 */
export function AnimatedNumber({ value, format, className = "" }: { value: number; format: (n: number) => string; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const fmt = useRef(format);
  fmt.current = format;
  const initial = useRef<string | null>(null);
  initial.current ??= format(value);

  // A new formatter (unit toggle, locale) must re-render the shown value even when it did not change.
  useEffect(() => {
    if (el.current) el.current.textContent = format(shown.current);
  });

  useEffect(() => {
    const node = el.current;
    const from = shown.current;
    if (!node || from === value) return;
    // Sub-display changes (e.g. +97 CR on a "52.3K CR" readout) tween silently instead of flashing.
    if (fmt.current(from) !== fmt.current(value)) {
      const tone = value > from ? UP : DOWN;
      node.animate([{ color: tone, textShadow: `0 0 10px ${tone}80`, offset: 0 }], { duration: FLASH_MS, easing: "ease-out" });
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shown.current = value;
      node.textContent = fmt.current(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / TWEEN_MS);
      shown.current = k === 1 ? value : from + (value - from) * (1 - (1 - k) ** 3);
      node.textContent = fmt.current(shown.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <span ref={el} className={`tabular-nums ${className}`}>{initial.current}</span>;
}
