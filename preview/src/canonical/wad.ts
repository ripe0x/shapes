// Re-exports the moved canonical renderer from packages/shapes-sdk, so every existing
// "../canonical/wad" import in this workspace and in web's @shared/canonical alias keeps
// resolving. The source of truth lives in packages/shapes-sdk/src/render/wad.ts.
export * from "shapes-sdk/render/wad";
