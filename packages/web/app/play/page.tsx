"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, WifiOff } from "lucide-react";
import { SandboxProvider } from "../../lib/sandbox.tsx";
import { OnlineProvider } from "../../lib/client/online.tsx";
import { probeServer } from "../../lib/client/auth.ts";
import { SERVER_URL } from "../../lib/client/config.ts";
import { PlayShell } from "../../components/shell/PlayShell.tsx";
import { Splash } from "../../components/shell/Splash.tsx";
import { Coach } from "../../components/shell/Coach.tsx";

type Mode = "probing" | "online" | "sandbox";

/**
 * Online against the tick server whenever `GET /api/health` answers within
 * 1.5 s; otherwise the in-browser sandbox with a retry pill. `?mode=sandbox`
 * skips the probe.
 */
function PlayInner() {
  const forced = useSearchParams().get("mode") === "sandbox";
  const [mode, setMode] = useState<Mode>(forced ? "sandbox" : "probing");
  const [unreachable, setUnreachable] = useState(false);

  const probe = useCallback(async () => {
    setMode("probing");
    const health = await probeServer(1500);
    setUnreachable(!health);
    setMode(health ? "online" : "sandbox");
  }, []);

  useEffect(() => {
    if (forced) { setMode("sandbox"); setUnreachable(false); } else void probe();
  }, [forced, probe]);

  if (mode === "probing") return <Splash progress={0.05} label={`Reaching ${SERVER_URL}`} />;

  return (
    <>
      {mode === "online" ? (
        <OnlineProvider fallback={(p, label) => <Splash progress={p} label={label} />}>
          <PlayShell />
          <Coach />
        </OnlineProvider>
      ) : (
        <SandboxProvider fallback={(p) => <Splash progress={p} />}>
          <PlayShell />
          <Coach />
        </SandboxProvider>
      )}
      {unreachable && (
        <div className="fixed left-1/2 top-12 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-500/40 bg-panel/95 px-3 py-1 text-[11px] text-amber-200 shadow-lg backdrop-blur">
          <WifiOff size={12} /> Offline sandbox — server unreachable
          <button onClick={() => void probe()} className="flex items-center gap-1 rounded-full border border-amber-500/40 px-2 py-px text-[10px] uppercase tracking-wide hover:bg-amber-500/10">
            <RefreshCw size={10} /> Retry
          </button>
        </div>
      )}
    </>
  );
}

export default function PlayPage() {
  return (
    <Suspense fallback={<Splash progress={0} label="Loading" />}>
      <PlayInner />
    </Suspense>
  );
}
