import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone", // Disabled — using `next start` on Railway
  serverExternalPackages: ["better-sqlite3", "pdfkit"],
  experimental: {
    // With middleware/proxy in play, Next buffers every request body and
    // SILENTLY TRUNCATES it at 10MB by default — which corrupted video
    // clip uploads (20-30MB .mov files) into "Invalid multipart body"
    // errors. Raise the cap above the biggest upload route: raw footage
    // sources at 400MB (clips cap at 200MB). Memory impact is bounded:
    // the clip uploader runs ≤2 concurrent, the source uploader 1.
    proxyClientMaxBodySize: "420mb",
  },
  typescript: {
    // TODO: Fix remaining type errors in marketing components + MCP tools
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
