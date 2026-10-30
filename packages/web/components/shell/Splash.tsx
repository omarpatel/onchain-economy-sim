import { Globe2 } from "lucide-react";

/** Full-screen boot screen with warmup progress. */
export function Splash({ progress, label = "Warming up the economy" }: { progress: number; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-obsidian text-slate-200">
      <div className="flex items-center gap-2 text-2xl font-bold tracking-wide">
        <Globe2 className="text-cyan" /> ECONOMY SIM
      </div>
      <div className="w-72">
        <div className="mb-1 flex justify-between text-[11px] text-muted">
          <span>{label}</span>
          <span className="font-mono tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded bg-white/10">
          <div className="h-full bg-cyan transition-[width] duration-150" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="text-[11px] text-muted">simulating supply chains, markets and an exchange…</div>
    </div>
  );
}
