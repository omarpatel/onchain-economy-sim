/** Obsidian glass palette shared by Tailwind, canvas and three. */
export const UI = {
  bg: "#0e0e10",
  panel: "#161618",
  edge: "rgba(255,255,255,0.08)",
  mint: "#3ddc97",
  mintBright: "#7dffb3",
  emerald: "#10b981",
  rose: "#f43f5e",
  gold: "#f59e0b",
  cyan: "#38bdf8",
  text: "#e5e7eb",
  muted: "#8b93a5",
} as const;

/** 12 well-separated hues for company ownership overlays / cap tables. */
export const COMPANY_PALETTE = [
  "#38bdf8", "#f472b6", "#a3e635", "#fb923c", "#c084fc", "#2dd4bf",
  "#facc15", "#f87171", "#60a5fa", "#4ade80", "#e879f9", "#fbbf24",
] as const;

/** Stable FNV-1a hash → palette index so a company keeps its color across reloads. */
export function companyColor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return COMPANY_PALETTE[h % COMPANY_PALETTE.length];
}
