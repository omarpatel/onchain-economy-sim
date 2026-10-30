import type { Config } from "tailwindcss";

/** Obsidian glass theme (see lib/palette.ts for the same values in JS). */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        obsidian: "#0e0e10",
        panel: "#161618",
        edge: "rgba(255,255,255,0.08)",
        muted: "#8b93a5",
        emerald: { DEFAULT: "#10b981", 400: "#34d399", 500: "#10b981" },
        rose: { DEFAULT: "#f43f5e", 400: "#fb7185", 500: "#f43f5e" },
        gold: "#f59e0b",
        cyan: { DEFAULT: "#38bdf8", 100: "#e0f2fe", 200: "#bae6fd", 300: "#7dd3fc" },
        mint: { DEFAULT: "#3ddc97", 300: "#7dffb3" },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        logo: ["var(--font-logo)", "var(--font-sans)", "ui-sans-serif", "sans-serif"],
      },
      /** HUD type scale: 2xs labels/keycaps · caption body · xs values (Tailwind's 12px) · sm titles. */
      fontSize: {
        "2xs": ["10px", { lineHeight: "14px" }],
        caption: ["11px", { lineHeight: "16px" }],
      },
      boxShadow: {
        /** floating glass: hairline top highlight + soft contact shadow */
        float: "inset 0 1px 0 rgba(255,255,255,.07), 0 18px 40px -16px rgba(0,0,0,.85), 0 2px 6px rgba(0,0,0,.35)",
        lift: "inset 0 1px 0 rgba(255,255,255,.12), 0 10px 22px -10px rgba(0,0,0,.9)",
        "glow-mint": "0 0 0 1px rgba(61,220,151,.45), 0 0 18px rgba(61,220,151,.35), inset 0 1px 0 rgba(255,255,255,.18)",
        keycap: "inset 0 -1px 0 rgba(0,0,0,.25), 0 1px 0 rgba(0,0,0,.6)",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(.2,.8,.2,1)",
        spring: "cubic-bezier(.34,1.56,.64,1)",
      },
      keyframes: {
        ticker: { "0%": { transform: "translateX(0)" }, "100%": { transform: "translateX(-50%)" } },
        rise: { "0%": { opacity: "0", transform: "translateY(8px) scale(.98)" }, "100%": { opacity: "1", transform: "none" } },
        pop: { "0%": { opacity: "0", transform: "scale(.92)" }, "100%": { opacity: "1", transform: "none" } },
        breathe: { "0%,100%": { opacity: ".55" }, "50%": { opacity: "1" } },
      },
      animation: {
        ticker: "ticker linear infinite",
        rise: "rise .26s cubic-bezier(.2,.8,.2,1) both",
        pop: "pop .18s cubic-bezier(.34,1.56,.64,1) both",
        breathe: "breathe 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
