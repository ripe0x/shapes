import type {Deployment} from "../chain/abi";
import type {SiteData} from "./data";
import {DENOMINATIONS as CANONICAL_AMOUNTS, LABELS as CANONICAL_LABELS} from "shapes-render/denominations";

/** Parses `Deployment.mintStart` (a JSON string) to the unix-seconds bigint the site computes
 *  against. Missing, empty, or non-numeric values mean open at deploy. */
export function mintStartOf(dep: Pick<Deployment, "mintStart">): bigint {
  try {
    return dep.mintStart ? BigInt(dep.mintStart) : 0n;
  } catch {
    return 0n;
  }
}

/** Parses `Deployment.mintFeeWei` (a JSON string) to the wei bigint it records. Null when
 *  missing, empty, or non-numeric, distinct from a recorded zero fee. */
export function mintFeeOf(dep: Pick<Deployment, "mintFeeWei">): bigint | null {
  try {
    return dep.mintFeeWei ? BigInt(dep.mintFeeWei) : null;
  } catch {
    return null;
  }
}

// The nine denominations, in wei, with their display labels. Derived from the canonical table so
// the two cannot drift; that table is ladder-selected at build time and parity-tested against
// src/lib/Denominations.sol.
export const DENOMINATIONS: {label: string; wei: bigint}[] = CANONICAL_AMOUNTS.map((wei, i) => ({
  label: CANONICAL_LABELS[i],
  wei,
}));

/** Fee for denomination `sel`: `SiteData.fees` once `loadSite` completes (chain is authoritative),
 *  seeded from the deployment record's flat fee before that so the mint button need not wait on
 *  the full site load. Null only when neither source has a value yet. */
export function seedFee(
  dep: Pick<Deployment, "mintFeeWei"> | undefined,
  data: Pick<SiteData, "fees"> | null,
  sel: number,
): bigint | null {
  if (data) return data.fees[sel] ?? null;
  return dep ? mintFeeOf(dep) : null;
}

/** Mint-gate start time: `SiteData.mintStart` once loaded, seeded from the deployment record's
 *  readback before that. Matches `seedFee`'s precedence so the gate and the fee flip to chain
 *  truth together. */
export function seedMintStart(
  dep: Pick<Deployment, "mintStart"> | undefined,
  data: Pick<SiteData, "mintStart"> | null,
): bigint {
  if (data) return data.mintStart;
  return dep ? mintStartOf(dep) : 0n;
}
