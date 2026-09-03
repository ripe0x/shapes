import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import bundledDeployment from "./public/deployment.json";

// The canonical renderer, denomination table and chain ABI are the parity-tested source of truth
// in `preview/src`. Import them here rather than copying, so this site can never drift from what
// the contract renders. `externalDir` lets Next compile those files from outside the app root; the
// `@shared/*` alias (mirrored in tsconfig) points at them.
const shared = resolve(__dirname, "../preview/src");

// Selects the denomination ladder at build time, pairing with the foundry profile of the same
// name (see preview/src/canonical/denominations.ts). An explicit SHAPES_LADDER always wins;
// production builds must set it (scripts/verify-netlify-mode.mjs). Unset, the default follows the
// deployment this build will serve: SHAPES_DEPLOYMENT_FILE when set (see app/lib/deployment.ts),
// else public/deployment.local.json when present (written by script/lived-in.sh for a local anvil
// chain, which deploys with the default mainnet profile), else the bundled deployment.json. A
// Sepolia target takes the testnet ladder, anything else mainnet, so a plain `next dev` cannot
// show one ladder against a contract using the other.
function defaultLadder(): string {
  let dep = bundledDeployment as { chainId?: number };
  const local = process.env.SHAPES_DEPLOYMENT_FILE || resolve(__dirname, "public/deployment.local.json");
  if (existsSync(local)) {
    try {
      dep = JSON.parse(readFileSync(local, "utf8")) as { chainId?: number };
    } catch {
      // Unreadable local file: fall through to the bundled deployment.
    }
  }
  return dep.chainId === 11155111 ? "testnet" : "";
}

const nextConfig: NextConfig = {
  env: {
    SHAPES_LADDER: process.env.SHAPES_LADDER || defaultLadder(),
  },
  async redirects() {
    // /how-it-works was retired; its content lives in the landing page's mechanics section.
    return [{ source: "/how-it-works", destination: "/#lineage", permanent: true }];
  },
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
