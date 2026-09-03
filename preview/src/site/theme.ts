import type React from "react";

/** Design tokens for the public site: the paper system shared with the launch page and the Playground. */
export const C = {
  page: "#f7f7f3",
  ink: "#11110f",
  body: "#2f2f2b",
  bodyDim: "#4f4f49",
  muted: "#686862",
  faint: "#aaa9a1",
  rule: "#d8d8d1",
  ruleInner: "#e7e7e1",
  border: "#b9b9b1",
  row: "#efefe9",
  art: "#000000",
} as const;

export const FONT = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
export const SANS = "Arial, Helvetica, sans-serif";

/** 10px 0.14em uppercase section label. */
export const label: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.14em",
  color: C.muted,
};
