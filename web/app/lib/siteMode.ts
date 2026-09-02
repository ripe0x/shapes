export type SiteMode = "landing" | "app" | "hybrid";

/**
 * `hybrid` keeps the launch page at `/` and exposes the Sepolia app at `/mint` plus its related
 * routes. Netlify must always choose a mode explicitly before it is allowed to build
 * (scripts/verify-netlify-mode.mjs). A local dev server with no mode set runs the app at `/`;
 * set SHAPES_SITE_MODE=hybrid or landing to work on the launch page locally.
 */
export function siteMode(): SiteMode {
  const value = process.env.SHAPES_SITE_MODE;
  if (value === "landing" || value === "app" || value === "hybrid") return value;
  return process.env.NODE_ENV === "development" ? "app" : "hybrid";
}

export const landingOnly = () => siteMode() === "landing";
export const appOnly = () => siteMode() === "app";
