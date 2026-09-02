/** Human-facing identity for a Shape. `isOwnerToken` marks the live Shape currently holding
 *  collection ownership (see `ownerToken()`); it moves across compose, decompose and split, so
 *  callers must pass the current owner-token state rather than comparing against a fixed id. */
export function shapeTitle(tokenId: bigint, isOwnerToken: boolean): string {
  return isOwnerToken ? "Shapes Collection Owner" : `Shape ${tokenId.toString()}`;
}

/** Compact identity for token cards. */
export function compactShapeTitle(tokenId: bigint, isOwnerToken: boolean): string {
  return isOwnerToken ? "Collection Owner" : `#${tokenId.toString()}`;
}
