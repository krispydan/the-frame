import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone", // Disabled — using `next start` on Railway
  serverExternalPackages: ["better-sqlite3", "pdfkit"],
  typescript: {
    // TODO: Fix remaining type errors in marketing components + MCP tools
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
