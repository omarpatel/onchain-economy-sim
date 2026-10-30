import type { Metadata } from "next";
import { JetBrains_Mono, Lilita_One, Nunito } from "next/font/google";
import { Providers } from "./providers.tsx";
import { SITE_URL } from "../lib/client/config.ts";
import "./globals.css";

const sans = Nunito({ subsets: ["latin"], weight: ["400", "600", "700", "800"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const logo = Lilita_One({ subsets: ["latin"], weight: "400", variable: "--font-logo", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Economy Sim — multiplayer economic strategy on Solana",
  description: "Build companies, run supply chains, go public, trade shares and stake $ECON. Off-chain economy, on-chain settlement.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${logo.variable}`}>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
