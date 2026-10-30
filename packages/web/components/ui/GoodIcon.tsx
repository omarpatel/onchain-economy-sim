"use client";

import { useId, type ReactNode } from "react";
import type { Good } from "@econ-sim/sim/goods";

/** Dominant flat colour per good, shared with cards / legends. */
export const GOOD_TINT: Record<Good, string> = {
  iron_ore: "#b8664a",
  coal: "#4b4b58",
  crude_oil: "#3a3a44",
  wheat: "#e6bf52",
  timber: "#9c6436",
  water: "#4db6f2",
  steel: "#a6b3c4",
  fuel: "#e04a3c",
  planks: "#d3a462",
  flour: "#efe4cd",
  machinery: "#8896aa",
  tools: "#c88c4c",
  bread: "#dd9b46",
  furniture: "#b9783f",
};

/** Multiply an #rrggbb by `f` (>1 lightens, <1 darkens), clamped. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

interface Tone { base: string; dark: string; light: string }

const TONES: Record<Good, Tone> = Object.fromEntries(
  (Object.keys(GOOD_TINT) as Good[]).map((g) => [g, { base: GOOD_TINT[g], dark: shade(GOOD_TINT[g], 0.62), light: shade(GOOD_TINT[g], 1.35) }]),
) as Record<Good, Tone>;

/** 12-tooth gear outline, generated once. */
const GEAR_PATH = (() => {
  const pts: string[] = [];
  const teeth = 10, ro = 16, ri = 12.5, cx = 20, cy = 20;
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a0 = (Math.PI * 2 * i) / (teeth * 2) - Math.PI / (teeth * 4);
    const a1 = a0 + Math.PI / (teeth * 2);
    pts.push(`${i === 0 ? "M" : "L"}${(cx + r * Math.cos(a0)).toFixed(2)} ${(cy + r * Math.sin(a0)).toFixed(2)}`);
    pts.push(`L${(cx + r * Math.cos(a1)).toFixed(2)} ${(cy + r * Math.sin(a1)).toFixed(2)}`);
  }
  return `${pts.join(" ")} Z`;
})();

/** Body drawing per good; `g` is the vertical base→dark gradient fill. */
const ART: Record<Good, (g: string, c: Tone) => ReactNode> = {
  iron_ore: (g, c) => (
    <>
      <path d="M5 31 L12 15 L22 9 L32 16 L35 31 Z" fill={g} />
      <path d="M5 31 L12 15 L19 24 Z" fill={c.dark} opacity={0.45} />
      <path d="M22 9 L32 16 L25 22 Z" fill={c.light} opacity={0.5} />
      <circle cx="16" cy="22" r="2.2" fill="#e8825f" />
      <circle cx="26" cy="26" r="1.8" fill="#e8825f" />
      <circle cx="21" cy="15" r="1.4" fill="#f4a988" />
    </>
  ),
  coal: (g, c) => (
    <>
      <path d="M4 30 L9 19 L18 17 L22 24 L19 31 Z" fill={g} />
      <path d="M18 31 L21 20 L30 15 L36 22 L34 31 Z" fill={g} />
      <path d="M12 18 L16 8 L26 9 L28 16 L20 17 Z" fill={g} />
      <path d="M16 8 L26 9 L23 13 Z" fill={c.light} opacity={0.35} />
      <path d="M21 20 L30 15 L28 21 Z" fill={c.light} opacity={0.3} />
      <path d="M4 30 L9 19 L11 25 Z" fill={c.light} opacity={0.2} />
    </>
  ),
  crude_oil: (g, c) => (
    <>
      <rect x="10" y="8" width="20" height="25" rx="3" fill={g} />
      <ellipse cx="20" cy="8.5" rx="10" ry="3" fill={c.light} />
      <rect x="10" y="14" width="20" height="2" fill={c.dark} />
      <rect x="10" y="24" width="20" height="2" fill={c.dark} />
      <rect x="13" y="12" width="2.5" height="19" rx="1" fill="#fff" opacity={0.12} />
      <path d="M20 13 C20 13 16 18 16 20.5 A4 4 0 0 0 24 20.5 C24 18 20 13 20 13 Z" fill="#111" opacity={0.8} />
    </>
  ),
  wheat: (g, c) => (
    <>
      <path d="M20 36 L20 10" stroke={c.dark} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M20 30 C15 29 12 26 12 22" stroke={c.dark} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M20 31 C25 30 28 27 28 23" stroke={c.dark} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      {[8, 13, 18, 23].map((y, i) => (
        <g key={i}>
          <ellipse cx="16.5" cy={y + 2} rx="2.6" ry="4" transform={`rotate(-28 16.5 ${y + 2})`} fill={g} />
          <ellipse cx="23.5" cy={y + 2} rx="2.6" ry="4" transform={`rotate(28 23.5 ${y + 2})`} fill={g} />
        </g>
      ))}
      <ellipse cx="20" cy="7" rx="2.6" ry="4" fill={c.light} />
      <ellipse cx="16" cy="11" rx="0.9" ry="1.6" transform="rotate(-28 16 11)" fill="#fff" opacity={0.35} />
    </>
  ),
  timber: (g, c) => (
    <>
      <rect x="5" y="12" width="26" height="16" rx="3" fill={g} />
      <path d="M8 16 L28 16 M8 24 L28 24" stroke={c.dark} strokeWidth="1.3" opacity={0.6} />
      <path d="M9 20 L24 20" stroke={c.light} strokeWidth="1.2" opacity={0.35} />
      <ellipse cx="31" cy="20" rx="4.5" ry="8" fill="#e4bd85" />
      <ellipse cx="31" cy="20" rx="2.6" ry="5" fill="none" stroke="#b4884f" strokeWidth="1" />
      <ellipse cx="31" cy="20" rx="1" ry="2" fill="#b4884f" />
    </>
  ),
  water: (g, c) => (
    <>
      <path d="M20 4 C20 4 8 18 8 25.5 A12 12 0 0 0 32 25.5 C32 18 20 4 20 4 Z" fill={g} />
      <path d="M14 22 C14 18 17 14 19 12" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none" opacity={0.55} />
      <ellipse cx="22" cy="30" rx="6" ry="2.5" fill={c.dark} opacity={0.5} />
      <circle cx="26" cy="27" r="1.4" fill="#fff" opacity={0.35} />
    </>
  ),
  steel: (g, c) => (
    <>
      <path d="M4 33 L8 25 L20 25 L24 33 Z" fill={g} />
      <path d="M16 33 L20 25 L32 25 L36 33 Z" fill={g} />
      <path d="M10 24 L14 16 L26 16 L30 24 Z" fill={g} />
      <path d="M14 16 L26 16 L24 19 L16 19 Z" fill={c.light} opacity={0.7} />
      <path d="M8 25 L20 25 L19 28 L9 28 Z" fill={c.light} opacity={0.4} />
      <path d="M20 25 L32 25 L31 28 L21 28 Z" fill={c.light} opacity={0.4} />
      <path d="M11 17 L13 17" stroke="#fff" strokeWidth="1.4" opacity={0.6} strokeLinecap="round" />
    </>
  ),
  fuel: (g, c) => (
    <>
      <rect x="8" y="12" width="24" height="23" rx="3" fill={g} />
      <rect x="12" y="6" width="12" height="7" rx="2.5" fill={c.dark} />
      <rect x="14.5" y="8" width="7" height="3" rx="1.2" fill={g} />
      <rect x="25" y="7" width="6" height="6" rx="1" fill="#2d2d33" />
      <path d="M13 17 L27 30 M27 17 L13 30" stroke={c.dark} strokeWidth="2.2" strokeLinecap="round" opacity={0.7} />
      <rect x="11" y="15" width="2.5" height="8" rx="1" fill="#fff" opacity={0.25} />
    </>
  ),
  planks: (g, c) => (
    <>
      <rect x="4" y="9" width="32" height="7" rx="1.2" fill={g} transform="rotate(-4 20 12)" />
      <rect x="4" y="17" width="32" height="7" rx="1.2" fill={g} />
      <rect x="4" y="25" width="32" height="7" rx="1.2" fill={g} transform="rotate(3 20 28)" />
      <path d="M7 20.5 L18 20.5 M22 20.5 L33 20.5" stroke={c.dark} strokeWidth="1.2" opacity={0.6} strokeLinecap="round" />
      <path d="M8 12 L22 11" stroke={c.dark} strokeWidth="1.2" opacity={0.6} strokeLinecap="round" transform="rotate(-4 20 12)" />
      <path d="M10 28.5 L30 29.5" stroke={c.dark} strokeWidth="1.2" opacity={0.6} strokeLinecap="round" />
      <rect x="4" y="9" width="32" height="2" rx="1" fill={c.light} opacity={0.45} transform="rotate(-4 20 12)" />
    </>
  ),
  flour: (g, c) => (
    <>
      <path d="M10 17 C7 23 7 30 11 34 L29 34 C33 30 33 23 30 17 Z" fill={g} />
      <path d="M14 9 C14 6 26 6 26 9 L27 17 L13 17 Z" fill={c.dark} />
      <path d="M12 15 L28 15" stroke="#8a6a44" strokeWidth="2" strokeLinecap="round" />
      <rect x="14" y="22" width="12" height="6" rx="1" fill="#8a6a44" opacity={0.55} />
      <path d="M16 25 L24 25" stroke="#fff" strokeWidth="1.2" opacity={0.5} strokeLinecap="round" />
      <path d="M12 19 C11 23 11 28 13 31" stroke="#fff" strokeWidth="2" opacity={0.5} strokeLinecap="round" fill="none" />
    </>
  ),
  machinery: (g, c) => (
    <>
      <path d={GEAR_PATH} fill={g} />
      <circle cx="20" cy="20" r="8" fill={c.dark} />
      <circle cx="20" cy="20" r="4.5" fill="#1b1d22" />
      <path d="M12 12 A11 11 0 0 1 20 9" stroke="#fff" strokeWidth="2" opacity={0.35} fill="none" strokeLinecap="round" />
      <circle cx="20" cy="20" r="2" fill={c.light} opacity={0.5} />
    </>
  ),
  tools: (g, c) => (
    <>
      <rect x="18.5" y="15" width="4" height="21" rx="1.5" fill={g} transform="rotate(-38 20.5 25)" />
      <rect x="6" y="9" width="17" height="8" rx="2" fill="#8c98a8" transform="rotate(-38 14.5 13)" />
      <rect x="7" y="10" width="15" height="2.5" rx="1" fill="#c9d2de" opacity={0.7} transform="rotate(-38 14.5 13)" />
      <rect x="18.5" y="14" width="4" height="21" rx="1.5" fill="#8c98a8" transform="rotate(38 20.5 24.5)" />
      <circle cx="29.5" cy="11.5" r="5.5" fill="#8c98a8" />
      <circle cx="29.5" cy="11.5" r="2.6" fill="#1b1d22" />
      <rect x="29" y="4" width="5" height="6" fill="#1b1d22" transform="rotate(45 31.5 7)" />
      <rect x="26" y="8" width="2" height="4" rx="1" fill="#fff" opacity={0.4} />
    </>
  ),
  bread: (g, c) => (
    <>
      <path d="M5 25 C5 12 35 12 35 25 A5 5 0 0 1 30 30 L10 30 A5 5 0 0 1 5 25 Z" fill={g} />
      <path d="M11 19 L14 23 M18 17 L21 21 M25 17 L28 21" stroke={c.light} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M8 24 L32 24" stroke={c.dark} strokeWidth="1.2" opacity={0.5} />
      <path d="M8 17 C11 13 16 12 20 12" stroke="#fff" strokeWidth="2" opacity={0.35} fill="none" strokeLinecap="round" />
    </>
  ),
  furniture: (g, c) => (
    <>
      <rect x="9" y="5" width="4" height="20" rx="1.2" fill={g} />
      <rect x="27" y="5" width="4" height="20" rx="1.2" fill={g} />
      <rect x="12" y="8" width="16" height="3.5" rx="1" fill={c.dark} />
      <rect x="12" y="14" width="16" height="3.5" rx="1" fill={c.dark} />
      <rect x="7" y="21" width="26" height="6" rx="1.5" fill={g} />
      <rect x="9" y="27" width="3.5" height="9" rx="1" fill={c.dark} />
      <rect x="27.5" y="27" width="3.5" height="9" rx="1" fill={c.dark} />
      <rect x="8" y="21.5" width="24" height="1.8" rx="0.9" fill={c.light} opacity={0.5} />
    </>
  ),
};

/** Chunky flat-shaded inline SVG for a good; reads at 32–48px. */
export function GoodIcon({ good, size = 40, className = "" }: { good: Good; size?: number; className?: string }) {
  const id = useId();
  const c = TONES[good];
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={`block shrink-0 ${className}`} aria-label={good} role="img">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c.base} />
          <stop offset="0.65" stopColor={c.base} />
          <stop offset="1" stopColor={c.dark} />
        </linearGradient>
      </defs>
      <ellipse cx="20" cy="35" rx="12" ry="2.5" fill="#000" opacity={0.28} />
      {ART[good](`url(#${id})`, c)}
    </svg>
  );
}
