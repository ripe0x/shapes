import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deploymentRecordName, ladderForChainId } from "../preview/src/site/deploymentRecord";
import bundledDeployment from "./public/deployment.json";
import bundledDeploymentSepolia from "./public/deployment.sepolia.json";

// The canonical renderer, denomination table and chain ABI are the parity-tested source of truth
// in `preview/src`. Import them here rather than copying, so this site can never drift from what
// the contract renders. `externalDir` lets Next compile those files from outside the app root; the
// `@shared/*` alias (mirrored in tsconfig) points at them.
const shared = resolve(__dirname, "../preview/src");

// Bundled records this build could serve. Both statically imported (rather than read by path) so
// either is part of the production bundle; see `app/lib/deployment.ts` and
// `app/ShapesProviders.tsx`, which select the same file at runtime by the same variable.
const BUNDLED_RECORDS: Record<string, { chainId?: number }> = {
  deployment: bundledDeployment,
  "deployment.sepolia": bundledDeploymentSepolia,
};

/** Deployment record this build actually targets: SHAPES_DEPLOYMENT_FILE when set (see
 *  app/lib/deployment.ts), else public/deployment.local.json when present (written by
 *  script/lived-in.sh for a local anvil chain, which deploys with the default mainnet profile),
 *  else the bundled record NEXT_PUBLIC_SHAPES_DEPLOYMENT names (default `deployment.json`, the
 *  record `app/ShapesProviders.tsx` fetches on the client). */
function targetDeployment(): { chainId?: number } {
  const overridePath =
    process.env.SHAPES_DEPLOYMENT_FILE || resolve(__dirname, "public/deployment.local.json");
  if (existsSync(overridePath)) {
    try {
      return JSON.parse(readFileSync(overridePath, "utf8")) as { chainId?: number };
    } catch {
      // Unreadable override: fall through to the bundled record.
    }
  }
  const name = deploymentRecordName(process.env.NEXT_PUBLIC_SHAPES_DEPLOYMENT);
  return BUNDLED_RECORDS[name] ?? bundledDeployment;
}

const targetChainId = targetDeployment().chainId;

// Selects the denomination ladder at build time, pairing with the foundry profile of the same
// name (see preview/src/canonical/denominations.ts). An explicit SHAPES_LADDER always wins.
// Unset, the default follows
// targetDeployment(): a Sepolia target takes the testnet ladder, anything else mainnet, so a
// plain `next dev` cannot show one ladder against a contract using the other.
const resolvedLadder =
  process.env.SHAPES_LADDER || (ladderForChainId(targetChainId) === "testnet" ? "testnet" : "");

// Build-time guard: NEXT_PUBLIC_SHAPES_DEPLOYMENT (which record to serve) and SHAPES_LADDER
// (which denomination table to compile in) are set independently per Netlify site. A record for
// one chain paired with the other chain's ladder would build without error and then show wrong
// amounts against the live contract, so a mismatch fails the build instead.
if (targetChainId !== undefined) {
  const expected = ladderForChainId(targetChainId);
  const actual = resolvedLadder === "testnet" ? "testnet" : "mainnet";
  if (actual !== expected) {
    throw new Error(
      `next.config.ts: SHAPES_LADDER=${actual} does not match chain ${targetChainId}, which needs ` +
        `the ${expected} ladder. Check NEXT_PUBLIC_SHAPES_DEPLOYMENT and SHAPES_LADDER together.`,
    );
  }
}

const nextConfig: NextConfig = {
  env: {
    SHAPES_LADDER: resolvedLadder,
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
