import type { Metadata } from "next";
import { Landing } from "../components/landing/Landing.tsx";

export const metadata: Metadata = {
  openGraph: {
    title: "Economy Sim — build an empire in a living economy",
    description: "Found a company, run supply chains, trade on a market that clears every tick and take your firm public. Dividends settle on Solana.",
    images: ["/shots/city.webp"],
  },
};

/** Marketing page; everything live (3D city, market tape, leaderboard) streams in client-side from /api/economy. */
export default function Page() {
  return <Landing />;
}
