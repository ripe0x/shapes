// Decoded event args as JSON: uint values become decimal strings and addresses lowercase, so a
// reader compares addresses without case folding and parses amounts with BigInt().
export function jsonArgs(args: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (typeof value === "string") out[key] = value.startsWith("0x") && value.length === 42 ? value.toLowerCase() : value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else throw new Error(`unsupported event arg ${key}`);
  }
  return out;
}

// Block number inside a Ponder checkpoint string: 10 timestamp digits, 16 chain id digits, then
// 16 block number digits (ponder/dist/esm/utils/checkpoint.js, pinned at ponder 0.17.8).
export function checkpointBlock(checkpoint: string): number {
  if (!/^\d{75}$/.test(checkpoint)) throw new Error(`unexpected checkpoint ${checkpoint}`);
  return Number(checkpoint.slice(26, 42));
}
