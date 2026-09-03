import {parseEther} from "viem";

/**
 * Text-field input to an ABI argument, for the call forms on `/contracts`. Every failure is
 * returned as a message; nothing here throws.
 */
export type ParseResult = {ok: true; value: unknown} | {ok: false; error: string};

const HEX = /^0x[0-9a-fA-F]*$/;

/** Splits a tuple type's component list on top-level commas: "(uint256,(bool,address)[])". */
function splitComponents(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (inner.length > 0) parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Trailing `[]` or `[k]` of an array type, with the element type. Null for a non-array type. */
function arrayOf(type: string): {element: string; length: number | null} | null {
  if (!type.endsWith("]")) return null;
  const open = type.lastIndexOf("[");
  if (open < 0) return null;
  const size = type.slice(open + 1, -1);
  return {element: type.slice(0, open), length: size === "" ? null : Number(size)};
}

function toBigInt(value: unknown, type: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`${type} must be a whole number`);
    return BigInt(value);
  }
  if (typeof value !== "string") throw new Error(`${type} must be a number`);
  const text = value.trim();
  if (!/^-?(0x[0-9a-fA-F]+|\d+)$/.test(text)) throw new Error(`${text || "empty"} is not a ${type}`);
  return BigInt(text);
}

/** Converts one already-JSON-decoded value to what viem encodes for `type`. Throws on a mismatch. */
function coerce(type: string, value: unknown): unknown {
  const array = arrayOf(type);
  if (array) {
    if (!Array.isArray(value)) throw new Error(`${type} must be a JSON array`);
    if (array.length !== null && value.length !== array.length) {
      throw new Error(`${type} needs exactly ${array.length} items`);
    }
    return value.map((item) => coerce(array.element, item));
  }
  if (type.startsWith("(")) {
    const components = splitComponents(type.slice(1, -1));
    if (!Array.isArray(value)) throw new Error(`${type} must be a JSON array of its ${components.length} fields`);
    if (value.length !== components.length) {
      throw new Error(`${type} needs exactly ${components.length} fields`);
    }
    return components.map((component, i) => coerce(component, value[i]));
  }
  if (type.startsWith("uint") || type.startsWith("int")) return toBigInt(value, type);
  if (type === "bool") {
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
    throw new Error("bool must be true or false");
  }
  if (type === "address") {
    const text = String(value).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error("An address is 0x followed by 40 hex characters");
    return text;
  }
  if (type === "string") return String(value);
  if (type.startsWith("bytes")) {
    const text = String(value).trim();
    if (!HEX.test(text) || text.length % 2 !== 0) throw new Error(`${type} must be 0x followed by an even number of hex characters`);
    const size = type.slice("bytes".length);
    if (size !== "" && text.length !== 2 + Number(size) * 2) {
      throw new Error(`${type} must be exactly ${size} bytes`);
    }
    return text;
  }
  throw new Error(`Unsupported type ${type}`);
}

/**
 * Parses the raw text of one argument field. A scalar is read verbatim, so `123`, `0xabc…` and a
 * plain string need no quoting; an array or tuple is read as JSON, positionally for a tuple.
 */
export function parseArg(type: string, raw: string): ParseResult {
  const text = raw.trim();
  const structured = arrayOf(type) !== null || type.startsWith("(");
  if (text.length === 0 && !structured && type !== "string") return {ok: false, error: "Required"};
  try {
    if (!structured) return {ok: true, value: coerce(type, type === "string" ? raw : text)};
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return {ok: false, error: `${type} must be valid JSON, for example [1, 2]`};
    }
    return {ok: true, value: coerce(type, decoded)};
  } catch (e) {
    return {ok: false, error: e instanceof Error ? e.message : String(e)};
  }
}

/** Parses a whole argument list, returning the first field that failed. */
export function parseArgs(
  inputs: readonly {name: string; type: string}[],
  raw: readonly string[],
): {ok: true; values: unknown[]} | {ok: false; index: number; error: string} {
  const values: unknown[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const parsed = parseArg(inputs[i].type, raw[i] ?? "");
    if (!parsed.ok) return {ok: false, index: i, error: parsed.error};
    values.push(parsed.value);
  }
  return {ok: true, values};
}

/** Parses the ETH value field of a payable call to wei. Empty means zero. */
export function parseEthValue(raw: string): ParseResult {
  const text = raw.trim();
  if (text.length === 0) return {ok: true, value: 0n};
  if (!/^\d+(\.\d+)?$/.test(text)) return {ok: false, error: "Value must be an ETH amount, for example 0.05"};
  try {
    return {ok: true, value: parseEther(text)};
  } catch {
    return {ok: false, error: "Value must be an ETH amount, for example 0.05"};
  }
}
