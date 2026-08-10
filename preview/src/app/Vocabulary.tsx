import React from "react";
import {C, mono} from "./ui";
import {vocabulary, renderModuleSwatch, type Appearance} from "../canonical/render";
import type {Kind, Params} from "../canonical/params";

const KIND_LABEL: Record<Kind, string> = {
  circle: "circle",
  square: "square",
  triangle: "triangle",
  half: "half circle",
  quarter: "quarter circle",
  diamond: "diamond",
};

function swatchForDisplay(svg: string): string {
  return svg.replace(
    'width="100" height="100"',
    'width="100%" height="100%" style="display:block"',
  );
}

function Swatch({a, params}: {a: Appearance; params: Params}) {
  const svg = React.useMemo(
    () => renderModuleSwatch(a.kind, a.solid, a.rot, params),
    [a.kind, a.solid, a.rot, params],
  );
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 5, width: 84}}>
      <div
        style={{
          width: 84,
          height: 84,
          background: "#000",
          borderRadius: 5,
          overflow: "hidden",
          lineHeight: 0,
        }}
        dangerouslySetInnerHTML={{__html: swatchForDisplay(svg)}}
      />
      <div style={{...mono, fontSize: 9, letterSpacing: "0.04em", color: C.mid, textAlign: "center"}}>
        <span style={{fontSize: 11}}>{a.glyph}</span>{" "}
        {a.solid ? "solid" : "outline"}
        {a.rot !== 0 || a.kind === "triangle" || a.kind === "half" || a.kind === "quarter"
          ? ` · ${a.rot}°`
          : ""}
      </div>
    </div>
  );
}

export function Vocabulary({params}: {params: Params}) {
  // Group the flat appearance list by kind, preserving KIND_ORDER.
  const groups = React.useMemo(() => {
    const all = vocabulary(params.kinds);
    const byKind = new Map<Kind, Appearance[]>();
    for (const a of all) {
      const list = byKind.get(a.kind) ?? [];
      list.push(a);
      byKind.set(a.kind, list);
    }
    return [...byKind.entries()];
  }, [params.kinds]);

  const total = groups.reduce((n, [, list]) => n + list.length, 0);

  return (
    <div style={{paddingBottom: 40}}>
      <div style={{...mono, fontSize: 11, letterSpacing: "0.08em", color: C.mid, marginBottom: 22, maxWidth: 720, lineHeight: 1.6}}>
        THE FULL VISUAL LANGUAGE · {total} DISTINCT MODULE APPEARANCES
        <div style={{fontSize: 11, color: C.dim, marginTop: 6, letterSpacing: "0.02em"}}>
          Every form the generator can place in a cell: each primitive in solid and outline,
          across its distinct rotations. Circle, square and diamond are rotation-invariant, so
          each contributes two; triangle, half and quarter rotate, so each contributes eight.
          Swatches use the committed fill and stroke — adjust the controls above to see the whole
          vocabulary shift together.
        </div>
      </div>

      <div style={{display: "flex", flexDirection: "column", gap: 26}}>
        {groups.map(([kind, list]) => (
          <div key={kind}>
            <div
              style={{
                ...mono,
                fontSize: 11,
                letterSpacing: "0.14em",
                color: C.ink,
                textTransform: "uppercase",
                borderBottom: `1px solid ${C.hair}`,
                paddingBottom: 8,
                marginBottom: 14,
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>{KIND_LABEL[kind]}</span>
              <span style={{color: C.dim}}>{list.length} forms</span>
            </div>
            <div style={{display: "flex", flexWrap: "wrap", gap: 16}}>
              {list.map((a, i) => (
                <Swatch key={`${kind}-${i}`} a={a} params={params} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
