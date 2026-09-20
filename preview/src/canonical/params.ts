// Re-exports the moved canonical renderer from packages/shapes-sdk, so every existing
// "../canonical/params" import in this workspace and in web's @shared/canonical alias keeps
// resolving. The source of truth lives in packages/shapes-sdk/src/render/params.ts.
export * from "shapes-sdk/render/params";
