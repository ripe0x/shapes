import type {ProvNode} from "../chain/history";

/** Rollups are layout sentinels, never token cards. `id: 0n` is not a token reference here. */
export function isProvenanceRollup(node: Pick<ProvNode, "more">): node is Pick<ProvNode, "more"> & {more: number} {
  return typeof node.more === "number" && node.more > 0;
}

export function provenanceRollupLabel(node: Pick<ProvNode, "more">): string {
  return `+${node.more ?? 0} more`;
}
