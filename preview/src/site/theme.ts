import type React from "react";

/** Design tokens for the public site, from the "Ledger" handoff. */
export const C = {
  page: "#0d0d0c",
  ink: "#e6e4dd",
  body: "#cfcdc6",
  bodyDim: "#a5a59e",
  muted: "#71716b",
  faint: "#4f4f4a",
  rule: "#262622",
  ruleInner: "#1c1c19",
  border: "#3a3a34",
  row: "#161613",
  art: "#000000",
} as const;

export const FONT = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/** 10px 0.14em uppercase section label. */
export const label: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.14em",
  color: C.muted,
};
