"use client";

import { useEffect, useState } from "react";
import { Coins, Hammer, Move3d, TrendingUp, X } from "lucide-react";
import { Button } from "../ui/index.tsx";

const COACH_KEY = "econ.coach.v1";

const STEPS = [
  { icon: <Move3d size={16} />, title: "Look around", body: "Drag to orbit, scroll to zoom, WASD or arrows to pan. The HQ button in the hotbar flies back to your headquarters; Walk drops you onto the streets." },
  { icon: <Hammer size={16} />, title: "Build a supply chain", body: "Press B to open the build menu, pick a building and click a tile next to your HQ. Extractors need the right resource; factories turn goods into higher-value goods." },
  { icon: <TrendingUp size={16} />, title: "Work the market", body: "The Market tab quotes 14 goods every tick. Buy inputs, sell output, or set a per-good policy to auto-sell surplus. The Bank tab lends CR against your credit score." },
  { icon: <Coins size={16} />, title: "Go public, pay dividends", body: "Once you are profitable, IPO in the Company tab and set a payout ratio. Epoch dividends of on-chain companies settle to $ECON on Solana; claim them in the Chain tab with a wallet." },
];

/** Four-step first-visit walkthrough; dismissed state is remembered in localStorage. */
export function Coach() {
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    if (!window.localStorage.getItem(COACH_KEY)) setStep(0);
  }, []);
  if (step === null) return null;
  const done = () => { window.localStorage.setItem(COACH_KEY, "1"); setStep(null); };
  const s = STEPS[step];
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-end justify-center pb-28">
      <div className="glass pointer-events-auto w-[min(420px,calc(100vw-24px))] rounded-lg p-4 shadow-2xl ring-1 ring-mint/20" role="dialog" aria-label="Getting started">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-white"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-mint/15 text-mint-300">{s.icon}</span>{s.title}</div>
          <button onClick={done} className="text-muted hover:text-white" aria-label="Dismiss"><X size={14} /></button>
        </div>
        <p className="text-xs leading-relaxed text-slate-300">{s.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1">
            {STEPS.map((_, i) => <span key={i} className={`h-1.5 w-4 rounded-full ${i === step ? "bg-mint" : "bg-white/15"}`} />)}
          </div>
          <div className="flex gap-1">
            <Button size="sm" tone="ghost" onClick={done}>Skip</Button>
            {step < STEPS.length - 1
              ? <Button size="sm" tone="primary" onClick={() => setStep(step + 1)}>Next</Button>
              : <Button size="sm" tone="primary" onClick={done}>Start building</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}
