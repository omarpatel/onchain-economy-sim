import { fromCr, fromEcon } from "@econ-sim/sim/units";

/** Number → "1,234.5". */
export function num(n: number, digits = 0): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Number → "12.3K" / "4.5M". */
export function compact(n: number, digits = 1): string {
  if (Math.abs(n) < 1000) return num(n, digits);
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: digits }).format(n);
}

export interface MoneyOpts {
  /** compact K/M notation (default true above 10k) */
  compact?: boolean;
  /** decimal digits when not compact */
  digits?: number;
  /** prefix a sign, "+" for positives */
  sign?: boolean;
  /** append the unit suffix (default true) */
  unit?: boolean;
}

function fmtMoney(whole: number, suffix: string, o: MoneyOpts): string {
  const useCompact = o.compact ?? Math.abs(whole) >= 10_000;
  const body = useCompact ? compact(Math.abs(whole), 1) : num(Math.abs(whole), o.digits ?? 2);
  const sign = whole < 0 ? "−" : o.sign && whole > 0 ? "+" : "";
  return `${sign}${body}${o.unit === false ? "" : ` ${suffix}`}`;
}

/** CR minor units (cents) → "1,234.56 CR" / "12.3K CR". */
export function fmtCr(minor: number, o: MoneyOpts = {}): string {
  return fmtMoney(fromCr(minor), "CR", o);
}

/** $ECON minor units (micro) → "12.5 $ECON". */
export function fmtEcon(minor: number, o: MoneyOpts = {}): string {
  return fmtMoney(fromEcon(minor), "$ECON", { digits: 2, ...o });
}

/** USD → "$123.45". */
export function fmtUsd(usd: number, digits = 2): string {
  return `$${num(usd, digits)}`;
}

/** Fraction → "+5.2%". */
export function fmtPct(frac: number, digits = 1, sign = true): string {
  if (!Number.isFinite(frac)) return "—";
  const v = frac * 100;
  const s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
  return `${s}${Math.abs(v).toFixed(digits)}%`;
}

/** Tailwind text color class for a signed value. */
export function signColor(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-rose-400";
  return "text-slate-400";
}

/** Tick → "D12 · 07h" using ticksPerDay. */
export function fmtClock(tick: number, ticksPerDay: number): string {
  const day = Math.floor(tick / ticksPerDay);
  const hour = tick % ticksPerDay;
  return `D${day} · ${String(hour).padStart(2, "0")}h`;
}

/** "machine_factory" → "Machine Factory". */
export function titleCase(id: string): string {
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Truncate a long id/pubkey: "abcd…wxyz". */
export function shortId(id: string, keep = 4): string {
  return id.length <= keep * 2 + 1 ? id : `${id.slice(0, keep)}…${id.slice(-keep)}`;
}
