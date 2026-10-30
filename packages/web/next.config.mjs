/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile the TypeScript-source workspace package so the App Router server
  // can run the authoritative simulation directly for snapshots.
  transpilePackages: ["@econ-sim/sim"],
  experimental: { externalDir: true },
};
export default nextConfig;
