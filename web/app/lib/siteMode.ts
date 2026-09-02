export type SiteMode = "landing" | "app" | "hybrid";

/**
 * `hybrid` keeps the launch page at `/` and exposes the Sepolia app at `/mint` plus its related
 * routes. Netlify must always choose a mode explicitly before it is allowed to build.
 */
export function siteMode(): SiteMode {
  const value = process.env.SHAPES_SITE_MODE;
  if (value === "landing" || value === "app") return value;
  return "hybrid";
}

export const landingOnly = () => siteMode() === "landing";
export const appOnly = () => siteMode() === "app";
