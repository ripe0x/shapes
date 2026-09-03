import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_FILES = new Set([
  "/",
  "/play",
  "/og/play",
  "/contract-animation.svg",
  "/favicon.ico",
]);

/**
 * Landing mode exposes only the chain-free launch surface. App mode serves every route.
 */
export function proxy(request: NextRequest) {
  if (process.env.SHAPES_SITE_MODE !== "landing") return NextResponse.next();

  const path = request.nextUrl.pathname;
  if (PUBLIC_FILES.has(path) || path.startsWith("/_next/")) return NextResponse.next();
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: "/:path*",
};
