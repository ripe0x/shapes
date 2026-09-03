import {hexToBytes, type Hex} from "viem";
import {effectiveModuleBytes, renderSampledShape} from "../canonical/sampling";
import {moduleBytesToHex} from "../canonical/moduleCodec";

export interface ComposePreviewState {
  denominationIndex: number;
  inkGene: number;
  faceValueWei: bigint;
  modules: Hex;
}

/**
 * A compose-record snapshot's rendered geometry: its own materialized bytes, or the seed-derived
 * grammar v1 expression when it recorded none (`ShapeTypes.sol`: "empty when it had none").
 * Mirrors `GeometrySampling.effectiveModulesOf` on the contract. Every renderer of record bytes
 * (decompose preview, split-from-record preview) must resolve through this before rendering, so
 * a seed-drawn compose input never reaches `buildComposeResultPreview` with empty modules.
 */
export function effectiveRecordModules(donor: {
  seed: bigint;
  denominationIndex: number;
  inkGene: number;
  modules: Hex;
}): Hex {
  return moduleBytesToHex(
    effectiveModuleBytes({
      seed: donor.seed,
      denomIndex: donor.denominationIndex,
      inkGene: donor.inkGene,
      modules: hexToBytes(donor.modules),
    }),
  );
}

export interface ComposeResultPreview {
  tokenId: bigint;
  denominationIndex: number;
  faceValueWei: bigint;
  image: string;
}

/** Render the exact materialized result returned by Shapes.previewCompose. */
export function buildComposeResultPreview(
  state: ComposePreviewState,
  tokenId: bigint,
): ComposeResultPreview {
  const svg = renderSampledShape(
    hexToBytes(state.modules),
    state.denominationIndex,
    tokenId,
    state.inkGene,
  );
  return {
    tokenId,
    denominationIndex: state.denominationIndex,
    faceValueWei: state.faceValueWei,
    image: `data:image/svg+xml;base64,${btoa(svg)}`,
  };
}
