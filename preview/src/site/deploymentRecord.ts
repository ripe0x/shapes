/**
 * Selects which bundled `public/<name>.json` deployment record a Next.js build serves, so the two
 * Netlify sites building this repo (Sepolia app, mainnet launch) can each point at their own
 * record from one build-time variable, NEXT_PUBLIC_SHAPES_DEPLOYMENT, instead of sharing the one
 * file both `web/app/lib/deployment.ts` (server) and `web/app/ShapesProviders.tsx` (client) used
 * to read. NEXT_PUBLIC_ so Next inlines it into the client bundle at build time.
 */

/** Record served when NEXT_PUBLIC_SHAPES_DEPLOYMENT is unset: the production/mainnet record. */
export const DEFAULT_DEPLOYMENT_RECORD = "deployment";

/** Name of the bundled `public/<name>.json` record to use, from NEXT_PUBLIC_SHAPES_DEPLOYMENT. */
export function deploymentRecordName(envValue: string | undefined): string {
  return envValue || DEFAULT_DEPLOYMENT_RECORD;
}

/** Denomination ladder a chain id requires (see preview/src/canonical/denominations.ts): the
 *  testnet ladder for Sepolia, the mainnet ladder for every other chain, including local anvil. */
export function ladderForChainId(chainId: number | undefined): "mainnet" | "testnet" {
  return chainId === 11155111 ? "testnet" : "mainnet";
}
