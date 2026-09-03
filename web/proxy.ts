import { NextResponse, type NextRequest } from "next/server";

const PRODUCTION_HOST = "shapes.ripe.wtf";
const PUBLIC_FILES = new Set([
  "/",
  "/play",
  "/og/play",
  "/contract-animation.svg",
  "/favicon.ico",
]);

/**
 * Domain-level backstop for the launch site. The production host must run landing mode, which
 * exposes only the chain-free launch surface.
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host")?.split(":", 1)[0]?.toLowerCase();
  if (host !== PRODUCTION_HOST) return NextResponse.next();

  const mode = process.env.SHAPES_SITE_MODE;
  if (mode !== "landing") return new NextResponse("Invalid production site mode.", { status: 503 });

  const path = request.nextUrl.pathname;
  if (PUBLIC_FILES.has(path) || path.startsWith("/_next/")) return NextResponse.next();
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: "/:path*",
};
