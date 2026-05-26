import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone", // Disabled — using `next start` on Railway
  serverExternalPackages: ["better-sqlite3", "pdfkit"],
  typescript: {
    // TODO: Fix remaining type errors in marketing components + MCP tools
    ignoreBuildErrors: true,
  },
  // Force Next's file tracer to include runtime assets that aren't
  // .js/.ts and therefore wouldn't be picked up automatically. The
  // Amazon download route reads template.xlsx via fs.readFile(); without
  // this entry the prod bundle ships the route but not the file, and
  // every download 500s with "Cannot access file template.xlsx".
  outputFileTracingIncludes: {
    "/api/v1/integrations/amazon/download": [
      "./src/modules/catalog/lib/amazon/template.xlsx",
    ],
  },
};

export default nextConfig;
