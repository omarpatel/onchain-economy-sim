"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { useMemo } from "react";
import { RPC_URL } from "../lib/client/config.ts";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Non-custodial wallet connection. Phantom, Solflare, Backpack et al. register
 * themselves via the Wallet Standard, so no per-wallet adapter packages are
 * needed. Sign-in is SIWS against the tick server (`lib/client/useWalletSignIn.ts`);
 * only on-chain claims prompt for a transaction signature.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
