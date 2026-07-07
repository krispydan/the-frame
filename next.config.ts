import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone", // Disabled — using `next start` on Railway
  serverExternalPackages: ["better-sqlite3", "pdfkit"],
  experimental: {
    // With middleware/proxy in play, Next buffers every request body and
    // SILENTLY TRUNCATES it at 10MB by default — which corrupted video
    // clip uploads (20-30MB .mov files) into "Invalid multipart body"
    // errors. Raise the cap above the clip route's 200MB limit. Memory
    // impact is bounded: the Uppy uploaders run ≤2 concurrent uploads.
    proxyClientMaxBodySize: "210mb",
  },
  typescript: {
    // TODO: Fix remaining type errors in marketing components + MCP tools
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
