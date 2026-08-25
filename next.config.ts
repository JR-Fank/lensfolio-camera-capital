import type { NextConfig } from "next";

const cloudflareWorkersShim = "./lib/legacy/cloudflare-workers.ts";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "cloudflare:workers": cloudflareWorkersShim,
    },
  },
  webpack(config) {
    config.resolve.alias["cloudflare:workers"] = cloudflareWorkersShim;
    return config;
  },
};

export default nextConfig;
