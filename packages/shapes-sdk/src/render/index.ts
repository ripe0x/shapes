// Public surface of the canonical renderer module. Consumers that need one call
// (`renderShapeSvg`) import from here or from the package root; a consumer porting deep preview
// tooling can still reach an individual file directly (`shapes-sdk/render/sampling`, etc.).
export * from "./render.ts";
export * from "./sampling.ts";
export * from "./denominations.ts";
export * from "./ink.ts";
export * from "./moduleCodec.ts";
export * from "./wad.ts";
export * from "./fromRow.ts";
