export type SiteMode = "landing" | "app" | "hybrid";

/**
 * `hybrid` is local-only convenience: the launch page at `/`, with the Sepolia app at `/mint`.
 * Every Netlify build must explicitly choose `landing` or `app` before it is allowed to build.
 */
export function siteMode(): SiteMode {
  const value = process.env.SHAPES_SITE_MODE;
  if (value === "landing" || value === "app") return value;
  return "hybrid";
}

export const landingOnly = () => siteMode() === "landing";
export const appOnly = () => siteMode() === "app";
