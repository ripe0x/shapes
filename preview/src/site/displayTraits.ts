import type {TokenMeta} from "./data";

export interface DisplayTrait {
  label: string;
  value: string;
  description: string;
}

const INK_CHANCE: Record<string, number> = {
  Void: 0,
  Faint: 15,
  Sparse: 35,
  Murk: 50,
  Dense: 65,
  Rich: 85,
  Solid: 100,
};

/**
 * Turns exhaustive onchain attributes into a concise, user-facing summary. Derived duplicates and
 * protocol jargon stay available in tokenURI, while the page shows only independently useful facts.
 */
export function displayTraits(attributes: TokenMeta["attributes"]): DisplayTrait[] {
  const value = new Map(attributes.map((attribute) => [attribute.trait_type, attribute.value]));
  const rows: DisplayTrait[] = [];
  const add = (traitType: string, label: string, description: string, format?: (raw: string) => string) => {
    const raw = value.get(traitType);
    if (raw === undefined) return;
    rows.push({label, value: format ? format(raw) : raw, description});
  };

  // ETH Value is already the Shape subtitle. Modules repeat the visible artwork, Module Count is
  // implied by Grid, Ink Tier is derived from Ink, and Formation/Complete/Black duplicate the more
  // precise provenance rows or the dedicated Black Shape state.
  add("Grid", "grid", "Artwork layout, shown as columns by rows.");
  add("Fill", "fill", "Whether the fill-capable modules rendered filled, outlined, or a mix.");

  const ink = value.get("Ink");
  if (ink !== undefined) {
    const chance = INK_CHANCE[ink];
    rows.push({
      label: "ink",
      value: ink,
      description:
        chance === undefined
          ? "The inherited fill tendency used to render this artwork."
          : `The inherited fill tendency: ${chance}% chance per fill-capable module.`,
    });
  }

  add("Primitive", "dominant module", "The module type used most often in this artwork.");
  add(
    "Variety",
    "module types",
    "How many of the ten module types appear in this artwork.",
    (raw) => `${raw} of 10`,
  );
  add(
    "Independent Origins",
    "mint origins",
    "Direct mint events whose origin credit is carried by this Shape.",
  );
  add(
    "Origin Density",
    "origin coverage",
    "The share of its smallest-denomination backing units carrying separate mint-origin credit.",
  );

  const composeDepth = value.get("Compose Depth");
  if (composeDepth !== undefined && composeDepth !== "0") {
    rows.push({
      label: "reversible composes",
      value: composeDepth,
      description: "Recent composes this Shape can still undo, newest first.",
    });
  }

  add("Split From", "split parent", "The denomination of the immediate Shape split to create this token.");
  add("Split Origin", "split root", "The denomination where this token's split lineage began.");

  return rows;
}
