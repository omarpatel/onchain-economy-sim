"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, BarChart3, Building2, Check, Coins, Eye, Factory, Gauge, Landmark, ShieldCheck, Truck, Wallet, Zap } from "lucide-react";
import type { EconomySnapshot } from "@econ-sim/sim/snapshot";
import { fmtCr, fmtPct, fmtUsd, num, signColor, titleCase } from "../../lib/format.ts";
import { companyColor } from "../../lib/palette.ts";
import { SERVER_URL } from "../../lib/client/config.ts";
import { GoodIcon } from "../ui/GoodIcon.tsx";
import { WalletSlot } from "../shell/WalletSlot.tsx";

const POLL_MS = 4000;

// three.js stays out of the first paint: the hero text renders immediately, the city fades in behind it.
const HeroCity = dynamic(() => import("./HeroCity.tsx"), { ssr: false });

type Source = "live" | "sandbox";

/** Polls the public economy feed (tick server, or the web server's demo economy when it's down). */
function useEconomy(): { snap: EconomySnapshot | null; source: Source | null } {
  const [snap, setSnap] = useState<EconomySnapshot | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/economy", { cache: "no-store" });
        if (!r.ok) return;
        const s = (await r.json()) as EconomySnapshot;
        if (alive) { setSnap(s); setSource(r.headers.get("x-econ-source") === "live" ? "live" : "sandbox"); }
      } catch {
        // keep the last snapshot; the next poll retries
      }
    };
    void load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return { snap, source };
}

/** Percent change of `now` against the close 24 candles back (or the first one we have). */
function change24(now: number, candles: { c: number }[]): number {
  const ref = candles.length ? candles[Math.max(0, candles.length - 25)].c : now;
  return ref > 0 ? (now - ref) / ref : 0;
}

export function Landing() {
  const { snap, source } = useEconomy();
  return (
    <div className="min-h-screen overflow-x-hidden bg-obsidian text-slate-200">
      <Hero snap={snap} source={source} />
      <MarketTape snap={snap} />
      <Features />
      <Companies snap={snap} />
      <How />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ─────────────────────────────── hero ─────────────────────────────── */

function Nav() {
  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="font-logo text-2xl tracking-wide text-mint-300 drop-shadow-[0_0_10px_rgba(125,255,179,.35)]">
          <span className="text-white">ECONOMY</span> SIM
        </Link>
        <nav className="hidden items-center gap-7 text-sm font-semibold text-slate-300 md:flex">
          <a href="#features" className="transition-colors hover:text-white">Gameplay</a>
          <a href="#companies" className="transition-colors hover:text-white">Leaderboard</a>
          <a href="#how" className="transition-colors hover:text-white">On-chain</a>
        </nav>
        <div className="flex items-center gap-2">
          <WalletSlot />
          <Link href="/play" className="hidden h-8 items-center gap-1.5 rounded-md bg-mint px-3 text-sm font-extrabold text-black transition-colors hover:bg-mint-300 sm:inline-flex">
            Play <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </header>
  );
}

const STAT_LABELS = ["Companies", "Buildings running", "Traded · 24 ticks", "$ECON"] as const;

function Hero({ snap, source }: { snap: EconomySnapshot | null; source: Source | null }) {
  const values = useMemo(() => {
    if (!snap) return STAT_LABELS.map(() => "—");
    const live = snap.world.tiles.filter((t) => t.building?.live).length;
    const traded = snap.goods.reduce((s, g) => s + g.volume24 * g.price, 0);
    return [num(snap.companies.length), num(live), fmtCr(traded, { compact: true }), fmtUsd(snap.chain.econPriceUsd, 4)];
  }, [snap]);

  return (
    <section className="relative h-[92vh] min-h-[640px] max-h-[980px] overflow-hidden">
      {/* poster gradient behind the city while three.js loads */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_45%,#3c5b3a_0%,#1b2a22_40%,#0e0e10_75%)]" />
      <div className="absolute inset-0 animate-[fadein_1.6s_ease-out_both]">{snap && <HeroCity snap={snap} />}</div>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-obsidian via-obsidian/75 to-transparent md:via-obsidian/55" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-obsidian/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-obsidian via-obsidian/70 to-transparent" />
      <Nav />

      <div className="relative z-10 mx-auto flex h-full max-w-7xl flex-col justify-center px-6 pt-16">
        <div className="max-w-xl">
          <LivePill snap={snap} source={source} />
          <h1 className="mt-5 font-logo text-[52px] leading-[0.95] tracking-wide text-white drop-shadow-[0_4px_24px_rgba(0,0,0,.6)] md:text-[76px]">
            Build an empire<br />in a <span className="text-mint-300">living</span> economy.
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-slate-300">
            Found a company on a shared map, wire up supply chains, trade on a market that clears every tick and take your firm public.
            Real dividends settle on Solana.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/play" className="group inline-flex h-12 items-center gap-2 rounded-lg bg-mint px-6 text-base font-extrabold text-black shadow-[0_0_0_1px_rgba(125,255,179,.5),0_10px_40px_-8px_rgba(61,220,151,.7)] transition-all hover:bg-mint-300">
              Play free <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link href="/play?mode=sandbox" className="inline-flex h-12 items-center rounded-lg border border-white/15 bg-white/[0.06] px-5 text-sm font-bold text-slate-100 backdrop-blur transition-colors hover:bg-white/[0.12]">
              Offline sandbox
            </Link>
          </div>
          <div className="mt-3 text-xs text-slate-400">No wallet needed · runs in your browser · wallet unlocks on-chain payouts</div>
        </div>

        <dl className="mt-14 grid max-w-3xl grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
          {STAT_LABELS.map((label, i) => (
            <div key={label} className="border-l border-white/15 pl-4">
              <dd className="font-mono text-2xl font-bold tabular-nums text-white">{values[i]}</dd>
              <dt className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</dt>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function LivePill({ snap, source }: { snap: EconomySnapshot | null; source: Source | null }) {
  const live = source === "live";
  return (
    <span
      title={live ? "Streaming from the authoritative tick server" : "Tick server unreachable — showing a demo economy simulated by the web server"}
      className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/40 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-200 backdrop-blur"
    >
      <span className="relative flex h-2 w-2">
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${live ? "bg-mint" : "bg-amber-400"}`} />
        <span className={`relative inline-flex h-2 w-2 rounded-full ${live ? "bg-mint" : "bg-amber-400"}`} />
      </span>
      {source === null ? "Connecting…" : live ? "Live economy" : "Demo economy"}
      {snap && <span className="font-mono font-semibold normal-case tracking-normal text-slate-400">tick {num(snap.tick)} · day {snap.epoch}</span>}
    </span>
  );
}

/* ─────────────────────────── market tape ─────────────────────────── */

function Spark({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return <span className="inline-block h-5 w-14" />;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 56},${18 - ((v - min) / span) * 16}`).join(" ");
  return (
    <svg width="56" height="20" viewBox="0 0 56 20" className="shrink-0" aria-hidden>
      <polyline points={pts} fill="none" stroke={up ? "#3ddc97" : "#fb7185"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function MarketTape({ snap }: { snap: EconomySnapshot | null }) {
  if (!snap) return <div className="h-16 border-y border-edge bg-panel/60" />;
  const items = snap.goods.map((g) => {
    const candles = snap.history.goods[g.good] ?? [];
    return { g, spark: candles.slice(-24).map((c) => c.c) };
  });
  const row = (key: string) => (
    <div key={key} className="flex shrink-0 items-center">
      {items.map(({ g, spark }) => (
        <div key={g.good} className="flex items-center gap-3 border-r border-edge px-6">
          <GoodIcon good={g.good} size={28} />
          <div className="leading-tight">
            <div className="text-xs font-bold text-slate-200">{titleCase(g.good)}</div>
            <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
              <span className="text-sm font-semibold text-white">{fmtCr(g.price, { unit: false })}</span>
              <span className={`text-[11px] ${signColor(g.change24)}`}>{fmtPct(g.change24)}</span>
            </div>
          </div>
          <Spark values={spark} up={g.change24 >= 0} />
        </div>
      ))}
    </div>
  );
  return (
    <div className="relative border-y border-edge bg-panel/60 py-3" aria-label="Live goods prices">
      <div className="ticker-track flex" style={{ animationDuration: `${snap.goods.length * 5}s` }}>
        {row("a")}
        {row("b")}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-obsidian to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-obsidian to-transparent" />
    </div>
  );
}

/* ───────────────────────────── features ───────────────────────────── */

const FEATURES: { eyebrow: string; title: string; body: string; points: { icon: ReactNode; text: string }[]; shot: string; alt: string }[] = [
  {
    eyebrow: "Production", title: "From ore to furniture",
    body: "14 goods, 14 buildings. Claim tiles with the right deposit, chain mines into smelters into machine shops, and keep your fleet moving.",
    points: [
      { icon: <Factory size={15} />, text: "Iron, coal, oil, wheat, timber and water deposits" },
      { icon: <Building2 size={15} />, text: "Watch construction rise, then the chimneys smoke" },
      { icon: <Truck size={15} />, text: "Trucks haul between your HQ and every plant" },
    ],
    shot: "/shots/build.webp", alt: "Build menu over the city with a building ghost on a free tile",
  },
  {
    eyebrow: "Cutaway", title: "Look inside any plant",
    body: "Lift the roof off your buildings and watch the line run: drills, furnaces and presses pace themselves to real utilization, crates carry your actual inputs and outputs, and idle plants go quiet.",
    points: [
      { icon: <Eye size={15} />, text: "One click or I — the camera glides in, Esc steps out" },
      { icon: <Gauge size={15} />, text: "Utilization, recipe and stock right beside the line" },
      { icon: <Coins size={15} />, text: "Every tick, income and output float up from your plants" },
    ],
    shot: "/shots/interior.webp", alt: "Cutaway of a forestry with its production line and recipe card",
  },
  {
    eyebrow: "Markets", title: "Prices that actually clear",
    body: "Every tick the market balances real supply and demand from players, NPC firms and households. Buy inputs, dump surplus, read the candles.",
    points: [
      { icon: <BarChart3 size={15} />, text: "Traded-price history, spread and market-maker float" },
      { icon: <Zap size={15} />, text: "Instant buy and sell, or auto-sell surplus per good" },
      { icon: <Coins size={15} />, text: "Bank credit lines priced by your credit score" },
    ],
    shot: "/shots/market.webp", alt: "Market item view with price chart and instant buy",
  },
  {
    eyebrow: "Equity", title: "Take your company public",
    body: "IPO through a book build, set your dividend payout and buy into rivals on a real order book. Founder shares stay locked while the market finds a price.",
    points: [
      { icon: <Landmark size={15} />, text: "Order book with bids, asks and self-trade protection" },
      { icon: <Wallet size={15} />, text: "Time-weighted dividends every epoch" },
      { icon: <ShieldCheck size={15} />, text: "Graduate on-chain only with real traded volume" },
    ],
    shot: "/shots/exchange.webp", alt: "Exchange tab listing public companies with sparklines and a candle chart",
  },
  {
    eyebrow: "Intel", title: "Read the city",
    body: "Flip on heat layers to see where land is cheap, where deposits are rich, which plants sit idle and which streets are jammed with trucks.",
    points: [
      { icon: <Gauge size={15} />, text: "Ownership, land price, richness, utilization, traffic" },
      { icon: <BarChart3 size={15} />, text: "Live stats for whatever is in the middle of the screen" },
      { icon: <Check size={15} />, text: "Search any company, building or good and fly there" },
    ],
    shot: "/shots/layers.webp", alt: "Traffic heat layer over the street grid",
  },
];

function Features() {
  return (
    <section id="features" className="mx-auto max-w-7xl scroll-mt-8 px-6 py-24">
      <SectionHead eyebrow="Gameplay" title="One map. Every company on it is someone's." sub="Players and NPC firms share the same 32×32 world, the same markets and the same exchange." />
      <div className="mt-16 flex flex-col gap-24">
        {FEATURES.map((f, i) => (
          <div key={f.title} className="grid items-center gap-10 md:grid-cols-2 md:gap-14">
            <div className={i % 2 ? "md:order-2" : ""}>
              <div className="text-xs font-extrabold uppercase tracking-[0.18em] text-mint-300">{f.eyebrow}</div>
              <h3 className="mt-2 font-logo text-4xl tracking-wide text-white">{f.title}</h3>
              <p className="mt-4 text-base leading-relaxed text-slate-300">{f.body}</p>
              <ul className="mt-6 flex flex-col gap-3">
                {f.points.map((p) => (
                  <li key={p.text} className="flex items-center gap-3 text-sm text-slate-200">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-mint/10 text-mint-300 ring-1 ring-mint/25">{p.icon}</span>
                    {p.text}
                  </li>
                ))}
              </ul>
            </div>
            <Shot src={f.shot} alt={f.alt} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Shot({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="relative">
      <div className="absolute -inset-6 rounded-[28px] bg-[radial-gradient(ellipse_at_center,rgba(61,220,151,.16),transparent_70%)] blur-2xl" />
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-panel shadow-[0_30px_80px_-20px_rgba(0,0,0,.9)]">
        <img src={src} alt={alt} loading="lazy" className="block w-full" />
      </div>
    </div>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="max-w-3xl">
      <div className="text-xs font-extrabold uppercase tracking-[0.18em] text-mint-300">{eyebrow}</div>
      <h2 className="mt-2 font-logo text-4xl tracking-wide text-white md:text-5xl">{title}</h2>
      <p className="mt-3 text-base text-slate-400">{sub}</p>
    </div>
  );
}

/* ──────────────────────────── leaderboard ──────────────────────────── */

function Companies({ snap }: { snap: EconomySnapshot | null }) {
  const top = useMemo(() => (snap ? [...snap.companies].sort((a, z) => z.valuation - a.valuation).slice(0, 6) : []), [snap]);
  return (
    <section id="companies" className="border-y border-edge bg-[linear-gradient(180deg,#121214,#0e0e10)]">
      <div className="mx-auto max-w-7xl scroll-mt-8 px-6 py-24">
        <SectionHead eyebrow="Leaderboard" title="Who runs the city right now" sub="Valuations, share prices and plants straight from the live economy, refreshed every few seconds." />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {snap === null && Array.from({ length: 6 }, (_, i) => <div key={i} className="h-40 animate-pulse rounded-xl border border-edge bg-panel" />)}
          {snap && top.map((c, i) => {
            const candles = snap.history.shares[c.id] ?? [];
            const ch = c.public ? change24(c.sharePrice, candles) : 0;
            return (
              <div key={c.id} className="group relative overflow-hidden rounded-xl border border-edge bg-panel p-5 transition-colors hover:border-white/20">
                <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: companyColor(c.id) }} />
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="font-logo text-3xl text-white/20">{i + 1}</span>
                    <div className="min-w-0">
                      <div className="truncate text-base font-extrabold text-white">{c.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                        <span className="h-2 w-2 rounded-full" style={{ background: companyColor(c.id) }} />
                        {c.isPlayer ? "Player" : "NPC"} · {num(c.buildings)} buildings
                        {c.public && <span className="rounded bg-amber-500/15 px-1.5 py-px font-bold text-amber-300">PUBLIC</span>}
                        {c.onChain && <span className="rounded bg-mint/15 px-1.5 py-px font-bold text-mint-300">ON-CHAIN</span>}
                      </div>
                    </div>
                  </div>
                  {c.public && <Spark values={candles.slice(-24).map((k) => k.c)} up={ch >= 0} />}
                </div>
                <div className="mt-5 grid grid-cols-3 gap-2">
                  <Fig label="Valuation" value={fmtCr(c.valuation, { compact: true })} />
                  <Fig label="Share" value={c.public ? fmtCr(c.sharePrice, { unit: false }) : "—"} sub={c.public ? <span className={signColor(ch)}>{fmtPct(ch)}</span> : undefined} />
                  <Fig label="Lifetime P&L" value={<span className={signColor(c.lifetimeProfit)}>{fmtCr(c.lifetimeProfit, { compact: true, sign: true, unit: false })}</span>} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Fig({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className="truncate font-mono text-[15px] font-bold tabular-nums text-slate-100">{value}</div>
      {sub && <div className="font-mono text-[11px] tabular-nums">{sub}</div>}
    </div>
  );
}

/* ───────────────────────────── on-chain ───────────────────────────── */

const STEPS = [
  { title: "Play at full speed", body: "One authoritative tick server runs the whole economy. Your actions are validated and applied atomically every tick — no gas, no waiting." },
  { title: "Settle every epoch", body: "At each epoch close, dividends of graduated companies and veECON yield become a Merkle root committed to Solana. The pool is capped by real creator fees: nothing in the sim can mint tokens." },
  { title: "Claim with your wallet", body: "Sign in with Solana and claim your $ECON straight from the distributor vault. Land NFTs and staking follow the same per-epoch settlement." },
];

function How() {
  return (
    <section id="how" className="mx-auto max-w-7xl scroll-mt-8 px-6 py-24">
      <SectionHead eyebrow="On-chain" title="Off-chain speed, on-chain truth" sub="The fun part runs in real time. The money part is verifiable." />
      <ol className="relative mt-14 grid gap-6 md:grid-cols-3">
        <div className="absolute left-0 right-0 top-6 hidden h-px bg-gradient-to-r from-mint/0 via-mint/40 to-mint/0 md:block" />
        {STEPS.map((s, i) => (
          <li key={s.title} className="relative">
            <span className="relative flex h-12 w-12 items-center justify-center rounded-full border border-mint/40 bg-obsidian font-logo text-xl text-mint-300 shadow-[0_0_24px_rgba(61,220,151,.25)]">{i + 1}</span>
            <h3 className="mt-5 text-lg font-extrabold text-white">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="px-6 pb-24">
      <div className="relative mx-auto max-w-7xl overflow-hidden rounded-2xl border border-white/10">
        <img src="/shots/city.webp" alt="" aria-hidden loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-r from-obsidian via-obsidian/80 to-obsidian/20" />
        <div className="relative px-8 py-16 md:px-14 md:py-20">
          <h2 className="max-w-xl font-logo text-4xl tracking-wide text-white md:text-5xl">The city is already running.</h2>
          <p className="mt-3 max-w-md text-base text-slate-300">Grab a plot before the rich deposits are taken. Your first company is free.</p>
          <Link href="/play" className="group mt-8 inline-flex h-12 items-center gap-2 rounded-lg bg-mint px-6 text-base font-extrabold text-black shadow-[0_10px_40px_-8px_rgba(61,220,151,.7)] transition-colors hover:bg-mint-300">
            Play free <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-edge">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-slate-400">
        <span className="font-logo text-lg tracking-wide text-mint-300"><span className="text-white">ECONOMY</span> SIM</span>
        <nav className="flex flex-wrap items-center gap-6">
          <Link href="/play" className="hover:text-white">Play online</Link>
          <Link href="/play?mode=sandbox" className="hover:text-white">Offline sandbox</Link>
          <a href="/api/economy" className="hover:text-white">Economy API</a>
          <a href={`${SERVER_URL}/api/health`} target="_blank" rel="noreferrer" className="hover:text-white">Server health</a>
          <a href="https://explorer.solana.com/?cluster=devnet" target="_blank" rel="noreferrer" className="hover:text-white">Solana devnet</a>
        </nav>
      </div>
    </footer>
  );
}
