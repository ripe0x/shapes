/** Human-facing identity for a Shape. `isOwnerToken` marks the live Shape currently holding
 *  collection ownership (see `ownerToken()`); it moves across compose, decompose and split, so
 *  callers must pass the current owner-token state rather than comparing against a fixed id. */
export function shapeTitle(tokenId: bigint, isOwnerToken: boolean): string {
  const base = `Shape ${tokenId.toString()}`;
  return isOwnerToken ? `${base}, Contract Owner` : base;
}

/** Compact identity for token cards. */
export function compactShapeTitle(tokenId: bigint, isOwnerToken: boolean): string {
  const base = `#${tokenId.toString()}`;
  return isOwnerToken ? `${base}, Contract Owner` : base;
}
