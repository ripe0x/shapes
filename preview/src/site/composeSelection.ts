import {DENOMINATIONS} from "../chain/abi";
import type {SiteToken} from "./data";

export interface ComposeRung {
  sourceIndex: number;
  targetIndex: number;
  totalShapes: number;
}

/** The measured production path composes one equal-denomination ladder rung at a time. */
export function composeRung(sourceIndex: number): ComposeRung | null {
  if (sourceIndex < 0 || sourceIndex >= DENOMINATIONS.length - 1) return null;
  const source = DENOMINATIONS[sourceIndex].wei;
  const target = DENOMINATIONS[sourceIndex + 1].wei;
  const ratio = target / source;
  if (ratio < 2n || ratio > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {sourceIndex, targetIndex: sourceIndex + 1, totalShapes: Number(ratio)};
}

export function ownedTokens(tokens: SiteToken[], address: string): SiteToken[] {
  return tokens.filter((token) => token.owner.toLowerCase() === address.toLowerCase());
}

export function eligibleRungTokens(tokens: SiteToken[], address: string, sourceIndex: number): SiteToken[] {
  return ownedTokens(tokens, address).filter((token) => token.di === sourceIndex);
}

export function selectedComposeTokens(tokens: SiteToken[], selectedIds: bigint[]): SiteToken[] {
  const byId = new Map(tokens.map((token) => [token.id.toString(), token]));
  return selectedIds.flatMap((id) => {
    const token = byId.get(id.toString());
    return token ? [token] : [];
  });
}

export function isCompleteRungSelection(
  tokens: SiteToken[],
  address: string,
  selectedIds: bigint[],
): boolean {
  if (new Set(selectedIds.map(String)).size !== selectedIds.length || selectedIds.length < 2) return false;
  const selected = selectedComposeTokens(tokens, selectedIds);
  if (selected.length !== selectedIds.length) return false;
  const sourceIndex = selected[0].di;
  const rung = composeRung(sourceIndex);
  return (
    rung !== null &&
    selected.length === rung.totalShapes &&
    selected.every(
      (token) =>
        token.di === sourceIndex &&
        token.di >= 0 &&
        token.owner.toLowerCase() === address.toLowerCase(),
    )
  );
}

export function composeBurnIds(selectedIds: bigint[], survivorId: bigint): bigint[] {
  return selectedIds
    .filter((id) => id !== survivorId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
