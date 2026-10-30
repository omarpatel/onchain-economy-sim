"use client";

import { useState } from "react";
import { useWorld } from "../../../lib/world.ts";
import { fmtCr, fmtUsd, fmtEcon, num } from "../../../lib/format.ts";
import { Badge, Bar, Button, FormError, NumberInput, Panel, Stat, Table } from "../../ui/index.tsx";
import { useIntent } from "../useIntent.ts";

export function BankTab() {
  const { snap, you } = useWorld();
  const credit = useIntent();
  const rwa = useIntent();
  const [loan, setLoan] = useState(1000);
  const [repay, setRepay] = useState(500);
  const [rwaSym, setRwaSym] = useState(snap.chain.rwa[0]?.symbol ?? "");
  const [rwaQty, setRwaQty] = useState(1);

  if (!you) return <div className="p-4 text-xs text-muted">Sign in to see your accounts.</div>;
  const co = you.company;
  const score = co ? (co.creditScore - 300) / 550 : 0;
  const quote = snap.chain.rwa.find((r) => r.symbol === rwaSym);
  const held = you.rwa.find((r) => r.symbol === rwaSym)?.qty ?? 0;
  const shareValue = you.holdings.reduce((s, h) => s + h.shares * h.lastPriceCr, 0);
  const maxLoan = co ? Math.floor(co.maxNewLoanCr / 100) : 0;
  // repay is bounded by what's owed and by what the company can actually pay
  const maxRepay = co ? Math.min(Math.ceil(co.debtCr / 100), Math.floor(co.cashCr / 100)) : 0;
  // whole shares of the selected RWA affordable in $ECON at the oracle quote (fee 0.15% on top); the desk only trades integers
  const maxRwaBuy = quote ? Math.floor((you.econ / 1_000_000) * snap.chain.econPriceUsd / quote.usd / 1.0015) : 0;

  return (
    <div className="flex flex-col gap-3 p-3">
      <Panel title="Accounts">
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat label="Wallet CR" value={fmtCr(you.cashCr)} size="sm" />
          <Stat label="Wallet $ECON" value={fmtEcon(you.econ)} size="sm" tone="cyan" />
          <Stat label="Staked $ECON" value={fmtEcon(you.stakedEcon)} size="sm" />
          <Stat label="Share portfolio" value={fmtCr(shareValue)} size="sm" />
          {co && <Stat label="Company cash" value={fmtCr(co.cashCr)} size="sm" />}
          {co && <Stat label="Company debt" value={fmtCr(co.debtCr)} size="sm" tone={co.debtCr > 0 ? "down" : "default"} />}
        </div>
      </Panel>

      {co && (
        <Panel title="Credit line" action={<Badge tone={co.creditScore >= 650 ? "up" : co.creditScore >= 450 ? "gold" : "down"}>score {co.creditScore}</Badge>}>
          <Bar value={score} tone={score > 0.6 ? "up" : score > 0.3 ? "gold" : "down"} />
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Stat label="Rate / tick" value={`${(co.rateBps / 100).toFixed(2)}%`} size="sm" />
            <Stat label="Outstanding" value={fmtCr(co.debtCr)} size="sm" />
            <Stat label="Available" value={fmtCr(co.maxNewLoanCr)} size="sm" tone="up" />
          </div>
          <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-2">
            <NumberInput label={`Borrow · max ${fmtCr(co.maxNewLoanCr, { compact: true })}`} value={loan} min={1} max={maxLoan} step={100} onChange={(v) => setLoan(Math.min(v, maxLoan))} suffix="CR" />
            <Button tone="primary" disabled={credit.busy || loan <= 0 || loan > maxLoan} onClick={() => credit.submit({ kind: "borrow", amountCr: Math.round(loan * 100) }, `Borrowed ${fmtCr(loan * 100)}`)}>Borrow</Button>
          </div>
          <div className="mt-2 grid grid-cols-[1fr_auto] items-end gap-2">
            <NumberInput label={`Repay · owed ${fmtCr(co.debtCr, { compact: true })} · max ${fmtCr(maxRepay * 100, { compact: true })}`} value={repay} min={1} max={maxRepay} step={100} onChange={(v) => setRepay(Math.min(v, maxRepay))} suffix="CR" />
            <Button disabled={credit.busy || repay <= 0 || repay > maxRepay || co.debtCr <= 0} onClick={() => credit.submit({ kind: "repay", amountCr: Math.min(Math.round(repay * 100), co.debtCr) }, `Repaid ${fmtCr(Math.min(Math.round(repay * 100), co.debtCr))}`)}>Repay</Button>
          </div>
          <div className="mt-1 flex gap-1">
            <Button size="sm" tone="ghost" onClick={() => setLoan(maxLoan)}>max loan</Button>
            <Button size="sm" tone="ghost" onClick={() => setRepay(maxRepay)}>repay all</Button>
          </div>
          <FormError text={credit.error} />
        </Panel>
      )}

      <Panel title="RWA desk" action={<span className="text-[10px] text-muted">$ECON → tokenized equities · fee 0.15%</span>}>
        <div className="mb-2 flex flex-wrap gap-1">
          {snap.chain.rwa.map((r) => (
            <Button key={r.symbol} size="sm" tone="ghost" active={r.symbol === rwaSym} onClick={() => setRwaSym(r.symbol)}>{r.symbol} <span className="font-mono text-muted">{fmtUsd(r.usd)}</span></Button>
          ))}
        </div>
        {quote && (
          <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
            <NumberInput label={`${quote.symbol} · ${fmtUsd(quote.usd)} · held ${num(held)} · max buy ${num(maxRwaBuy)}`} value={rwaQty} min={1} max={Math.max(maxRwaBuy, held, 1)} step={1} onChange={(v) => setRwaQty(Math.max(1, Math.floor(v)))} suffix="sh" />
            <Button tone="primary" disabled={rwa.busy || rwaQty < 1 || rwaQty > maxRwaBuy} title={maxRwaBuy < 1 ? `Need ${fmtUsd(quote.usd * 1.0015)} of $ECON for one share` : undefined} onClick={() => rwa.submit({ kind: "buy_rwa", symbol: quote.symbol, qty: rwaQty }, `Bought ${rwaQty} ${quote.symbol}`)}>Buy</Button>
            <Button tone="danger" disabled={rwa.busy || rwaQty < 1 || held < rwaQty} onClick={() => rwa.submit({ kind: "sell_rwa", symbol: quote.symbol, qty: rwaQty }, `Sold ${rwaQty} ${quote.symbol}`)}>Sell</Button>
          </div>
        )}
        <div className="mt-1 text-[10px] text-muted">≈ {fmtUsd((quote?.usd ?? 0) * rwaQty)} · {fmtEcon(Math.round(((quote?.usd ?? 0) * rwaQty / Math.max(1e-9, snap.chain.econPriceUsd)) * 1_000_000))}</div>
        <FormError text={rwa.error} />
        {you.rwa.length > 0 && (
          <div className="mt-2">
            <Table
              dense
              rows={you.rwa}
              rowKey={(r) => r.symbol}
              columns={[
                { key: "s", header: "Symbol", cell: (r) => r.symbol },
                { key: "q", header: "Qty", align: "right", cell: (r) => num(r.qty) },
                { key: "v", header: "Value", align: "right", cell: (r) => fmtUsd(r.usd) },
              ]}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
