"use client";

import { useId, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Minus, Plus, X } from "lucide-react";
import { useUi, type Toast as ToastModel } from "../../lib/store.ts";

/* ─────────────────────────── layout ─────────────────────────── */

export function Panel({ title, action, children, className = "", pad = true }: {
  title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean;
}) {
  return (
    <section className={`glass rounded-lg ${pad ? "p-3" : ""} ${className}`}>
      {(title || action) && (
        <header className={`flex items-center justify-between ${pad ? "mb-2" : "px-3 pt-3 pb-2"}`}>
          <h3 className="label">{title}</h3>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone = "default", mono = true, size = "md" }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "default" | "up" | "down" | "gold" | "cyan"; mono?: boolean; size?: "sm" | "md" | "lg";
}) {
  const color = { default: "text-slate-100", up: "text-mint-300", down: "text-rose-400", gold: "text-gold", cyan: "text-cyan" }[tone];
  const sz = { sm: "text-sm", md: "text-base", lg: "text-2xl" }[size];
  return (
    <div className="min-w-0">
      <div className="label truncate">{label}</div>
      <div className={`truncate font-semibold ${sz} ${color} ${mono ? "font-mono tabular-nums" : ""}`}>{value}</div>
      {sub !== undefined && <div className="truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "up" | "down" | "gold" | "cyan" | "mint" }) {
  const cls = {
    muted: "bg-white/5 text-slate-300 border-edge",
    up: "bg-mint/10 text-mint-300 border-mint/30",
    down: "bg-rose-500/10 text-rose-300 border-rose-500/30",
    gold: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    cyan: "bg-sky-500/10 text-sky-300 border-sky-500/30",
    mint: "bg-mint text-black border-mint",
  }[tone];
  return <span className={`inline-flex items-center rounded border px-1.5 py-px text-[10px] font-bold uppercase tracking-wide ${cls}`}>{children}</span>;
}

/* ─────────────────────────── table ─────────────────────────── */

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  width?: string;
}

export function Table<T>({ rows, columns, rowKey, onRow, activeKey, empty = "Nothing here yet", dense = false }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; onRow?: (row: T) => void; activeKey?: string | null; empty?: ReactNode; dense?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="label">
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width }} className={`border-b border-edge px-2 py-1.5 font-medium ${c.align === "right" ? "text-right" : "text-left"}`}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} className="px-2 py-4 text-center text-muted">{empty}</td></tr>
          )}
          {rows.map((r) => {
            const k = rowKey(r);
            const active = activeKey === k;
            return (
              <tr
                key={k}
                onClick={onRow ? () => onRow(r) : undefined}
                className={`${onRow ? "cursor-pointer hover:bg-white/[0.04]" : ""} ${active ? "bg-mint/10" : ""}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`border-b border-edge/60 px-2 ${dense ? "py-1" : "py-1.5"} font-mono tabular-nums ${c.align === "right" ? "text-right" : "text-left"}`}>{c.cell(r)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────── controls ─────────────────────────── */

export function Button({ children, onClick, tone = "default", size = "md", disabled, active, title, type = "button", className = "" }: {
  children: ReactNode; onClick?: () => void; tone?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md";
  disabled?: boolean; active?: boolean; title?: string; type?: "button" | "submit"; className?: string;
}) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-md border font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-40";
  const sz = size === "sm" ? "h-7 px-2 text-[11px]" : "h-8 px-3 text-xs";
  const tones = {
    default: "border-white/10 bg-white/[0.05] text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,.06)] hover:border-white/20 hover:bg-white/[0.1] hover:text-white",
    primary: "border-mint-300/60 bg-gradient-to-b from-mint-300 to-mint text-black shadow-[inset_0_1px_0_rgba(255,255,255,.45),0_4px_14px_-6px_rgba(61,220,151,.7)] hover:brightness-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,.45),0_6px_18px_-6px_rgba(61,220,151,.9)]",
    danger: "border-rose-400/60 bg-gradient-to-b from-rose-400 to-rose-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,.3),0_4px_14px_-6px_rgba(244,63,94,.7)] hover:brightness-110",
    ghost: "border-transparent bg-transparent text-slate-300 hover:bg-white/[0.07] hover:text-white",
  }[tone];
  const act = active ? "!border-mint/50 !bg-mint/15 !text-mint-300" : "";
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={`${base} ${sz} ${tones} ${act} ${className}`}>
      {children}
    </button>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, size = "md" }: {
  tabs: { id: T; label: ReactNode; icon?: ReactNode }[]; value: T; onChange: (id: T) => void; size?: "sm" | "md";
}) {
  return (
    <div role="tablist" className="flex gap-0.5 border-b border-edge">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`relative -mb-px flex min-w-0 items-center justify-center gap-1 whitespace-nowrap border-b-2 ${size === "sm" ? "flex-auto px-0.5 py-1.5 text-[10px] tracking-[0.05em]" : "flex-1 px-2 py-2 text-[11px] tracking-[0.1em]"} font-bold uppercase transition-[color,border-color] duration-150 ${on ? "border-mint text-white [text-shadow:0_0_12px_rgba(125,255,179,.45)]" : "border-transparent text-muted hover:border-white/15 hover:text-slate-200"}`}
          >
            {size !== "sm" && t.icon}{t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Keycap chip for keyboard hints (HUD, hotbar, coach). */
export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={`inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-gradient-to-b from-white to-slate-300 px-1 font-sans text-[9px] font-extrabold leading-none text-slate-900 shadow-keycap ${className}`}>
      {children}
    </kbd>
  );
}

/**
 * Round glass icon button (sm 30px · md 40px · lg 46px): lifts on hover, presses on click, glows mint when active.
 * `badge` is a red count bubble, `hotkey` a keycap chip, `tip` a label bubble that rises above on hover/focus.
 */
export function IconButton({ icon, label, onClick, active, badge, title, size = "md", hotkey, tip = false }: {
  icon: ReactNode; label: string; onClick?: () => void; active?: boolean; badge?: number | string; title?: string; size?: "sm" | "md" | "lg";
  hotkey?: string; tip?: boolean;
}) {
  const dim = { sm: "h-[30px] w-[30px]", md: "h-10 w-10", lg: "h-[46px] w-[46px]" }[size];
  const showBadge = badge !== undefined && badge !== 0 && badge !== "";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={tip ? undefined : title ?? label}
      onClick={onClick}
      className={`group glass relative inline-flex ${dim} shrink-0 items-center justify-center !rounded-full bg-[radial-gradient(120%_90%_at_50%_0%,rgba(255,255,255,.14),rgba(255,255,255,0)_60%)] transition-[transform,box-shadow,color,border-color,background-color] duration-150 ease-out hover:-translate-y-0.5 hover:bg-white/[0.08] hover:text-white hover:shadow-lift active:translate-y-0 active:scale-95 ${active ? "!border-mint/60 bg-mint/[0.14] text-mint-300 !shadow-glow-mint" : "text-slate-100"}`}
    >
      <span className="transition-transform duration-200 ease-spring group-hover:scale-110">{icon}</span>
      {showBadge && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 animate-pop items-center justify-center rounded-full bg-rose-500 px-1 font-mono text-[9px] font-bold leading-none text-white ring-2 ring-obsidian">
          {badge}
        </span>
      )}
      {hotkey && <Kbd className="absolute -bottom-1 -right-1 ring-1 ring-black/50">{hotkey}</Kbd>}
      {tip && (
        <span role="tooltip" className="glass pointer-events-none absolute bottom-full left-1/2 mb-2.5 -translate-x-1/2 translate-y-1 whitespace-nowrap !rounded-md px-2 py-1 text-[11px] font-bold text-slate-100 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          {title ?? label}
        </span>
      )}
    </button>
  );
}

/** Two/three-way pill; the active option is filled mint (BUY) or rose (SELL). */
export function SegmentedControl<T extends string>({ options, value, onChange, tone = "mint" }: {
  options: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void; tone?: "mint" | "rose";
}) {
  const fill = tone === "rose" ? "bg-rose-500 text-white" : "bg-mint text-black";
  return (
    <div role="radiogroup" className="flex rounded-md bg-black/40 p-0.5 shadow-[inset_0_1px_2px_rgba(0,0,0,.5)] ring-1 ring-edge">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={`h-8 flex-1 rounded-[5px] text-xs font-extrabold uppercase tracking-[0.12em] transition-[background-color,color,box-shadow] duration-150 ${on ? `${fill} shadow-[inset_0_1px_0_rgba(255,255,255,.35)]` : "text-slate-400 hover:text-slate-100"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** `− [value] +` quantity row; the value is editable in mono. */
export function Stepper({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, step = 1 }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const side = "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-white/[0.04] text-slate-200 transition-[background-color,transform] duration-150 hover:bg-white/[0.1] active:scale-95 disabled:opacity-30";
  return (
    <div className="inline-flex items-center gap-1">
      <button type="button" aria-label="decrease" disabled={value <= min} onClick={() => onChange(clamp(value - step))} className={side}><Minus size={13} /></button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? min : clamp(Number(e.target.value)))}
        className="h-8 w-16 rounded-md border border-edge bg-black/40 text-center font-mono text-sm font-semibold tabular-nums text-white outline-none focus:border-mint/60"
      />
      <button type="button" aria-label="increase" disabled={value >= max} onClick={() => onChange(clamp(value + step))} className={side}><Plus size={13} /></button>
    </div>
  );
}

/** Quick-pick chips (`16 · 64 · 256 · Max`). */
export function Chips<V>({ options, onPick, active }: { options: { label: ReactNode; value: V }[]; onPick: (v: V) => void; active?: V }) {
  return (
    <div className="inline-flex items-center gap-1">
      {options.map((o, i) => {
        const on = active !== undefined && Object.is(active, o.value);
        return (
          <button
            key={i}
            type="button"
            onClick={() => onPick(o.value)}
            className={`h-6 rounded-md border px-2 font-mono text-[10px] font-semibold tabular-nums transition-[background-color,border-color,color,transform] duration-150 active:scale-95 ${on ? "border-mint/60 bg-mint/15 text-mint-300" : "border-edge bg-white/[0.04] text-slate-300 hover:bg-white/[0.1] hover:text-white"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format }: {
  label: ReactNode; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block">
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular-nums text-slate-200">{format ? format(value) : value}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-sky-400" />
    </label>
  );
}

export function NumberInput({ label, value, onChange, min = 0, max, step = 1, suffix, placeholder }: {
  label?: ReactNode; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: ReactNode; placeholder?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block">
      {label && <div className="mb-1 text-[11px] text-muted">{label}</div>}
      <div className="flex h-8 items-center rounded-md border border-edge bg-black/40 focus-within:border-mint/60">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="h-full w-full bg-transparent px-2 font-mono text-xs tabular-nums text-slate-100 outline-none"
        />
        {suffix && <span className="pr-2 text-[10px] uppercase text-muted">{suffix}</span>}
      </div>
    </label>
  );
}

export function TextInput({ label, value, onChange, placeholder, maxLength }: {
  label?: ReactNode; value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block">
      {label && <div className="mb-1 text-[11px] text-muted">{label}</div>}
      <input
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-edge bg-black/40 px-2 text-xs text-slate-100 outline-none focus:border-mint/60"
      />
    </label>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-2 py-1 text-left">
      <span>
        <span className="block text-xs text-slate-200">{label}</span>
        {hint && <span className="block text-[10px] text-muted">{hint}</span>}
      </span>
      <span className={`relative h-4 w-8 shrink-0 rounded-full shadow-[inset_0_1px_2px_rgba(0,0,0,.4)] transition-colors duration-200 ${checked ? "bg-mint" : "bg-white/15"}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform duration-200 ease-spring ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}

/** Inline server rejection text under an intent form; renders nothing when clear. */
export function FormError({ text }: { text: string | null }) {
  if (!text) return null;
  return <div role="alert" className="mt-1.5 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{text}</div>;
}

/** Thin horizontal bar for utilization / ratios. */
export function Bar({ value, tone = "cyan", className = "" }: { value: number; tone?: "cyan" | "up" | "down" | "gold"; className?: string }) {
  const c = { cyan: "bg-cyan", up: "bg-mint", down: "bg-rose-400", gold: "bg-gold" }[tone];
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded bg-white/10 ${className}`}>
      <div className={`h-full rounded transition-[width] duration-500 ease-out ${c}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/* ─────────────────────────── sparkline ─────────────────────────── */

/** Min–max normalised line; `area` adds a soft gradient fill under it (the top-bar cash trend). */
export function Sparkline({ values, width = 80, height = 22, tone, area = false }: { values: number[]; width?: number; height?: number; tone?: "up" | "down" | "auto"; area?: boolean }) {
  const gid = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (values.length < 2) return <svg width={width} height={height} />;
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const step = width / (values.length - 1);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 1 - ((v - lo) / span) * (height - 2)).toFixed(1)}`).join(" ");
  const dir = tone === "auto" || !tone ? (values[values.length - 1] >= values[0] ? "up" : "down") : tone;
  const color = dir === "up" ? "#3ddc97" : "#f43f5e";
  return (
    <svg width={width} height={height} className="block overflow-visible">
      {area && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.35} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${gid})`} />
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ─────────────────────────── toasts ─────────────────────────── */

/** Lifetime per kind; mirrors the auto-dismiss timers in `useUi().toast` so the drain bar and exit fade land on removal. */
const TOAST_MS: Record<ToastModel["kind"], number> = { ok: 3500, info: 3500, error: 6000 };
/** Exit fade length; it starts this long before the store removes the toast. */
const TOAST_EXIT_MS = 180;

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div aria-live="polite" className="pointer-events-none absolute left-1/2 top-3 z-40 flex w-[min(380px,calc(100vw-24px))] -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />)}
    </div>
  );
}

const TOAST_TONE = {
  ok: { icon: <CheckCircle2 size={14} />, chip: "bg-mint/15 text-mint-300 ring-mint/30", bar: "bg-mint" },
  error: { icon: <AlertTriangle size={14} />, chip: "bg-rose-500/15 text-rose-300 ring-rose-500/30", bar: "bg-rose-400" },
  info: { icon: <Info size={14} />, chip: "bg-sky-400/15 text-sky-300 ring-sky-400/30", bar: "bg-sky-400" },
} as const;

/** Drops in, drains a progress bar over its lifetime, then fades out just before the store drops it (all CSS); × fades out first, then dismisses. */
function ToastItem({ toast, onClose }: { toast: ToastModel; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const ms = TOAST_MS[toast.kind];
  const t = TOAST_TONE[toast.kind];
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) onClose(); }}
      style={{ animation: closing ? `hud-out ${TOAST_EXIT_MS}ms ease-in forwards` : `hud-drop 240ms cubic-bezier(.2,.8,.2,1) both, hud-out ${TOAST_EXIT_MS}ms ease-in ${ms - TOAST_EXIT_MS}ms forwards` }}
      className="glass glass-ring pointer-events-auto flex w-full max-w-full items-center gap-2.5 !rounded-xl py-2 pl-2 pr-2.5 text-xs font-semibold text-slate-100 shadow-float"
    >
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ${t.chip}`}>{t.icon}</span>
      <span className="min-w-0 flex-1 leading-snug">{toast.text}</span>
      <button onClick={() => setClosing(true)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white" aria-label="dismiss"><X size={12} /></button>
      <span aria-hidden className={`absolute bottom-[3px] left-3 right-3 h-0.5 origin-left rounded-full opacity-70 ${t.bar}`} style={{ animation: `hud-drain ${ms}ms linear forwards` }} />
    </div>
  );
}
