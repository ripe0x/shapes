import React from "react";
import {C, label} from "./theme";

/**
 * The page grammar: a two-column section, 190px label column with a right border, content
 * column, 1px rule below. `labelNode` replaces the plain text label (used for the
 * decompose/recompose tabs). `pad` overrides the content padding where a screen needs to.
 */
export function Section({
  title,
  labelNode,
  pad = "24px 48px 26px 32px",
  last = false,
  children,
}: {
  title?: string;
  labelNode?: React.ReactNode;
  pad?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "190px minmax(0, 1fr)",
        borderBottom: last ? "none" : `1px solid ${C.rule}`,
      }}
    >
      <div style={{padding: "26px 24px 26px 48px", borderRight: `1px solid ${C.rule}`, ...label}}>
        {labelNode ?? title}
      </div>
      <div style={{padding: pad}}>{children}</div>
    </div>
  );
}

/** Artwork on its pure-black ground at the exact 2.5:3.5 card proportion. */
export function Art({src, alt = "", width}: {src: string; alt?: string; width?: number | string}) {
  return (
    <div style={{width: width ?? "100%", aspectRatio: "250 / 350", backgroundColor: C.art}}>
      <img
        src={src}
        alt={alt}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          animation: "artin .35s ease both",
        }}
      />
    </div>
  );
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const txUrl = (hash: string, chainId: number) =>
  `https://evm.now/tx/${hash}?chainId=${chainId}`;
