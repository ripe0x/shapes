import {hexToBytes, type Hex} from "viem";
import {renderSampledShape} from "../canonical/sampling";

export interface ComposePreviewState {
  denominationIndex: number;
  inkGene: number;
  faceValueWei: bigint;
  modules: Hex;
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
