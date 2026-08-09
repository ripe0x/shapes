import React from "react";

export const C = {
  bg: "#f0efec",
  ink: "#111",
  mid: "#555",
  dim: "#999",
  line: "#111",
  hair: "#dcd9d3",
  warn: "#a8300f",
  ok: "#1d6b3f",
};

export const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        ...mono,
        fontSize: 10,
        letterSpacing: "0.1em",
        color: C.dim,
        textTransform: "uppercase",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

export function Section({
  title,
  note,
  right,
  children,
}: {
  title: string;
  note?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 56 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 20,
          borderTop: `1px solid ${C.line}`,
          paddingTop: 12,
          marginBottom: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, letterSpacing: "0.14em", fontWeight: 500 }}>
            {title}
          </span>
          {note && (
            <span style={{ ...mono, fontSize: 10.5, color: C.dim, letterSpacing: "0.06em" }}>
              {note}
            </span>
          )}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Button({
  onClick,
  children,
  active,
  disabled,
  title,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...mono,
        fontSize: 11,
        letterSpacing: "0.06em",
        padding: "6px 11px",
        border: `1px solid ${active ? C.ink : C.hair}`,
        background: active ? C.ink : "transparent",
        color: disabled ? C.dim : active ? "#fff" : C.ink,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 3,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  width = 90,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  width?: number;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ ...mono, fontSize: 10, color: C.dim, letterSpacing: "0.08em" }}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(n);
        }}
        style={{
          ...mono,
          fontSize: 12,
          width,
          padding: "5px 7px",
          border: `1px solid ${C.hair}`,
          borderRadius: 3,
          background: "#fff",
        }}
      />
    </label>
  );
}

export function Slider({
  label,
  value,
  canonical,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  canonical: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const dirty = Math.abs(value - canonical) > 1e-12;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          ...mono,
          fontSize: 10,
          letterSpacing: "0.06em",
          color: dirty ? C.warn : C.dim,
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span>{label}</span>
        <span>
          {value.toFixed(4)}
          {dirty && <span style={{ color: C.dim }}> / {canonical.toFixed(4)}</span>}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: dirty ? C.warn : C.ink }}
      />
    </label>
  );
}

export function Toggle({
  label,
  checked,
  canonical,
  onChange,
}: {
  label: string;
  checked: boolean;
  canonical: boolean;
  onChange: (v: boolean) => void;
}) {
  const dirty = checked !== canonical;
  return (
    <label
      style={{
        ...mono,
        fontSize: 11,
        display: "flex",
        alignItems: "center",
        gap: 7,
        color: dirty ? C.warn : C.ink,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: dirty ? C.warn : C.ink }}
      />
      {label}
    </label>
  );
}

/**
 * The canonical SVG carries explicit width="250" height="350" because that is
 * what belongs in an onchain document. For on-screen layout we swap in a
 * responsive box. The geometry is untouched.
 */
export function forDisplay(svg: string): string {
  return svg.replace(
    'width="250" height="350"',
    'width="100%" height="100%" style="display:block"',
  );
}

/** Renders a canonical SVG string. */
export function Card({
  svg,
  onClick,
  caption,
  width,
  badge,
}: {
  svg: string;
  onClick?: () => void;
  caption?: string;
  width?: number | string;
  /** 1-based frame number when this card is in the animation selection. */
  badge?: number | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width }}>
      <div style={{position: "relative"}}>
        <div
          onClick={onClick}
          data-card=""
          data-selected={badge != null ? "true" : "false"}
          style={{
            aspectRatio: "2.5 / 3.5",
            background: "#000",
            borderRadius: 5,
            overflow: "hidden",
            cursor: onClick ? "pointer" : "default",
            lineHeight: 0,
            outline: badge != null ? `2px solid ${C.warn}` : "none",
            outlineOffset: 1,
          }}
          dangerouslySetInnerHTML={{ __html: forDisplay(svg) }}
        />
        {badge != null && (
          <div
            style={{
              ...mono,
              position: "absolute",
              top: 4,
              right: 4,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 8,
              background: C.warn,
              color: "#fff",
              fontSize: 9,
              lineHeight: "16px",
              textAlign: "center",
              fontWeight: 700,
            }}
          >
            {badge}
          </div>
        )}
      </div>
      {caption !== undefined && (
        <div
          style={{
            ...mono,
            fontSize: 9,
            letterSpacing: "0.06em",
            color: "#aaa",
            textAlign: "center",
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}
