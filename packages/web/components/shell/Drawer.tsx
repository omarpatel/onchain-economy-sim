"use client";

import { BarChart3, BookOpen, Building2, Landmark, Link2, ScanSearch, Wallet } from "lucide-react";
import { useUi, type DrawerTab } from "../../lib/store.ts";
import { Tabs } from "../ui/index.tsx";
import { InspectTab } from "./tabs/InspectTab.tsx";
import { CompanyTab } from "./tabs/CompanyTab.tsx";
import { MarketTab } from "./tabs/MarketTab.tsx";
import { ExchangeTab } from "./tabs/ExchangeTab.tsx";
import { BankTab } from "./tabs/BankTab.tsx";
import { ChainTab } from "./tabs/ChainTab.tsx";
import { LedgerTab } from "./tabs/LedgerTab.tsx";

const TABS: { id: DrawerTab; label: string; icon: React.ReactNode }[] = [
  { id: "inspect", label: "Inspect", icon: <ScanSearch size={12} /> },
  { id: "company", label: "Company", icon: <Building2 size={12} /> },
  { id: "market", label: "Market", icon: <BarChart3 size={12} /> },
  { id: "exchange", label: "Exchange", icon: <Landmark size={12} /> },
  { id: "bank", label: "Bank", icon: <Wallet size={12} /> },
  { id: "chain", label: "Chain", icon: <Link2 size={12} /> },
  { id: "ledger", label: "Ledger", icon: <BookOpen size={12} /> },
];

/**
 * Right panel with the seven data/action tabs: 380px column on desktop, a
 * bottom sheet over the canvas on phones (selecting a tile pops it up).
 */
export function Drawer() {
  const tab = useUi((s) => s.drawerTab);
  const setTab = useUi((s) => s.setTab);
  const open = useUi((s) => s.drawerOpen);
  const toggle = useUi((s) => s.toggleDrawer);
  return (
    <aside
      className={`glass flex shrink-0 flex-col !rounded-none !border-y-0 !border-r-0 transition-[width] duration-200 md:h-full ${open
        ? "md:w-[380px] max-md:fixed max-md:inset-x-0 max-md:bottom-6 max-md:z-50 max-md:h-[68vh] max-md:!rounded-t-2xl max-md:!border-x-0 max-md:!border-t max-md:shadow-[0_-20px_60px_rgba(0,0,0,.6)]"
        : "w-0 overflow-hidden !border-l-0 max-md:hidden"}`}
    >
      <button type="button" onClick={toggle} aria-label="Close panel" className="flex h-5 shrink-0 items-center justify-center md:hidden">
        <span className="h-1 w-10 rounded-full bg-white/25" />
      </button>
      <div className="px-2 pt-1">
        <Tabs tabs={TABS} value={tab} onChange={setTab} size="sm" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "inspect" && <InspectTab />}
        {tab === "company" && <CompanyTab />}
        {tab === "market" && <MarketTab />}
        {tab === "exchange" && <ExchangeTab />}
        {tab === "bank" && <BankTab />}
        {tab === "chain" && <ChainTab />}
        {tab === "ledger" && <LedgerTab />}
      </div>
    </aside>
  );
}
