import type { NextConfig } from "next";

// Static export: no server code, so nothing from the product app can ship here (ADR-0015).
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  turbopack: { root: process.cwd() },
};

export default nextConfig;
