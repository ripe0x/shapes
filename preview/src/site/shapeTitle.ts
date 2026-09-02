/** Human-facing identity for the transferable collection-ownership token and ordinary Shapes. */
export function shapeTitle(tokenId: bigint): string {
  return tokenId === 0n ? "Shapes Collection Owner" : `Shape ${tokenId.toString()}`;
}

/** Compact identity for token cards. */
export function compactShapeTitle(tokenId: bigint): string {
  return tokenId === 0n ? "Collection Owner" : `#${tokenId.toString()}`;
}
