/**
 * Module byte codec (SAMPLING_SPEC.md section 3).
 *
 * One byte encodes one module's intrinsic identity: kind, solid, rotation. No geometry.
 * `cx`, `cy`, `size`, `weight` are not encoded; they derive from the token's own grid geometry
 * and card constants (see `geometryAt`/`solveSize` in `./render`).
 *
 *   bit 7      always 0
 *   bits 6..5  rot   (0..3, meaning rot * 90 degrees clockwise)
 *   bit 4      solid (0 or 1)
 *   bits 3..0  kind  (0..9, the consensus KIND_ORDER index)
 *
 * A byte is valid iff bit 7 is clear, kind < KIND_ORDER.length, and rot < ROT_COUNT[kind].
 *
 * src/lib/ModuleCodec.sol is the Solidity port of this file; the parity suite asserts the two
 * agree byte for byte.
 */

import {KIND_ORDER, ROT_COUNT, type Kind, type Module} from "./render";

export const KIND_COUNT = KIND_ORDER.length;

const KIND_INDEX: ReadonlyMap<Kind, number> = new Map(
  KIND_ORDER.map((kind, i) => [kind, i]),
);

/** A module's intrinsic identity, decoded from one byte. */
export interface DecodedModule {
  kindIndex: number;
  kind: Kind;
  solid: boolean;
  /** 0, 90, 180 or 270 degrees, clockwise. */
  rot: number;
}

/** Index of a kind in KIND_ORDER, the value encoded into bits 3..0. */
export function kindIndexOf(kind: Kind): number {
  const i = KIND_INDEX.get(kind);
  if (i === undefined) throw new Error(`unknown kind: ${kind}`);
  return i;
}

/** Whether a byte satisfies every validity condition in section 3. */
export function isValidModuleByte(b: number): boolean {
  if (!Number.isInteger(b) || b < 0 || b > 0xff) return false;
  if ((b & 0x80) !== 0) return false; // bit 7 must be clear
  const kindIndex = b & 0x0f;
  if (kindIndex >= KIND_COUNT) return false;
  const rotCode = (b >> 5) & 0x03;
  return rotCode < ROT_COUNT[KIND_ORDER[kindIndex]];
}

/** Encode one module's identity into its byte. Throws on an out-of-range kind or rotation. */
export function encodeModuleByte(kindIndex: number, solid: boolean, rot: number): number {
  if (!Number.isInteger(kindIndex) || kindIndex < 0 || kindIndex >= KIND_COUNT) {
    throw new Error(`kind index out of range: ${kindIndex}`);
  }
  if (rot % 90 !== 0) throw new Error(`rotation not a multiple of 90: ${rot}`);
  const rotCode = (rot / 90) & 0xff;
  const maxRot = ROT_COUNT[KIND_ORDER[kindIndex]];
  if (rotCode < 0 || rotCode >= maxRot) {
    throw new Error(`rotation ${rot} invalid for kind index ${kindIndex} (max ${maxRot} orientations)`);
  }
  return ((rotCode & 0x03) << 5) | (solid ? 0x10 : 0) | kindIndex;
}

/** Decode one byte into a module's identity. Throws when the byte is invalid. */
export function decodeModuleByte(b: number): DecodedModule {
  if (!isValidModuleByte(b)) {
    throw new Error(`invalid module byte: 0x${(b & 0xff).toString(16).padStart(2, "0")}`);
  }
  const kindIndex = b & 0x0f;
  const solid = ((b >> 4) & 1) === 1;
  const rotCode = (b >> 5) & 0x03;
  return {kindIndex, kind: KIND_ORDER[kindIndex], solid, rot: rotCode * 90};
}

/** Encode a card's module list, row-major, into its byte array. Only kind/solid/rot are used. */
export function encodeModules(modules: readonly Pick<Module, "kind" | "solid" | "rot">[]): Uint8Array {
  const out = new Uint8Array(modules.length);
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    out[i] = encodeModuleByte(kindIndexOf(m.kind), m.solid, m.rot);
  }
  return out;
}

/** Decode a byte array into its module identities, row-major. Throws on the first invalid byte. */
export function decodeModules(bytes: Uint8Array): DecodedModule[] {
  const out: DecodedModule[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = decodeModuleByte(bytes[i]);
  return out;
}

/** Whether every byte in the array is valid per section 3 (invariant 1, byte level). */
export function isValidModuleArray(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (!isValidModuleByte(bytes[i])) return false;
  }
  return true;
}

export function moduleBytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s as `0x${string}`;
}
