export type SiteMode = "landing" | "app";

/**
 * `landing` restricts the production launch domain to the chain-free countdown page and `/play`.
 * `app` is the app home with the full mint panel at `/` plus all app routes, and is the default
 * when SHAPES_SITE_MODE is unset (including local dev). Netlify additionally refuses to build an
 * unsafe value for this env var (scripts/verify-netlify-mode.mjs).
 */
export function siteMode(): SiteMode {
  return process.env.SHAPES_SITE_MODE === "landing" ? "landing" : "app";
}

export const landingOnly = () => siteMode() === "landing";
export const appOnly = () => siteMode() === "app";
