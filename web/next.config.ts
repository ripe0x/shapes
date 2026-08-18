import type { NextConfig } from "next";
import { resolve } from "node:path";

// The canonical renderer, denomination table and chain ABI are the parity-tested source of truth
// in `preview/src`. Import them here rather than copying, so this site can never drift from what
// the contract renders. `externalDir` lets Next compile those files from outside the app root; the
// `@shared/*` alias (mirrored in tsconfig) points at them.
const shared = resolve(__dirname, "../preview/src");

const nextConfig: NextConfig = {
  experimental: {
    externalDir: true,
  },
  turbopack: {
    // Widen the resolution root to the repo so `preview/src` is in scope (it sits above web/).
    root: resolve(__dirname, ".."),
    resolveAlias: {
      "@shared": shared,
    },
  },
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, "@shared": shared };
    return config;
  },
};

export default nextConfig;
