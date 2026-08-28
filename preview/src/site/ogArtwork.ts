const JSON_PREFIX = "data:application/json;base64,";
const SVG_PREFIX = "data:image/svg+xml;base64,";

export const MAX_OG_TOKEN_URI_LENGTH = 1024 * 1024;
export const MAX_OG_SVG_BYTES = 768 * 1024;

function decodeBase64(value: string, maximumBytes: number): string | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return null;
  }
  // Four base64 characters encode at most three bytes. Reject before allocating the decode.
  if ((value.length / 4) * 3 > maximumBytes + 2) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.byteLength > maximumBytes) return null;
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    return null;
  }
}

function isPassiveSvg(svg: string): boolean {
  if (!/^\s*<svg\b/i.test(svg)) return false;
  const allowedElements = new Set(["svg", "g", "rect", "path", "polygon", "polyline", "line", "circle", "ellipse", "text"]);
  for (const match of svg.matchAll(/<\s*\/?\s*([a-z][a-z0-9:-]*)\b/gi)) {
    if (!allowedElements.has(match[1]!.toLowerCase())) return false;
  }
  return ![
    /<\s*(?:script|image|foreignobject|iframe|object|embed|use|a|style)\b/i,
    /<!\s*(?:doctype|entity)\b/i,
    /\b(?:href|xlink:href)\s*=/i,
    /\bon[a-z]+\s*=/i,
    /url\s*\(/i,
    /@import\b/i,
  ].some((pattern) => pattern.test(svg));
}

/** Accept only the bounded, self-contained metadata/artwork format emitted by Shapes. */
export function safeImageFromTokenURI(uri: string): string | null {
  if (!uri.startsWith(JSON_PREFIX) || uri.length > MAX_OG_TOKEN_URI_LENGTH) return null;
  const jsonText = decodeBase64(uri.slice(JSON_PREFIX.length), MAX_OG_TOKEN_URI_LENGTH);
  if (jsonText === null) return null;

  try {
    const metadata = JSON.parse(jsonText) as {image?: unknown};
    if (typeof metadata.image !== "string" || !metadata.image.startsWith(SVG_PREFIX)) return null;
    const svg = decodeBase64(metadata.image.slice(SVG_PREFIX.length), MAX_OG_SVG_BYTES);
    return svg !== null && isPassiveSvg(svg) ? metadata.image : null;
  } catch {
    return null;
  }
}
