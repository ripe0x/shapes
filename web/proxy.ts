import { NextResponse, type NextRequest } from "next/server";

const PRODUCTION_HOST = "shapes.ripe.wtf";
const PUBLIC_FILES = new Set(["/", "/contract-animation.svg", "/favicon.ico"]);

/**
 * Domain-level backstop for the launch site. Even if its Netlify environment is edited
 * incorrectly, the production hostname can never serve wallet, token, gallery, auction, or
 * playground routes. Changing this requires an intentional code deployment.
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host")?.split(":", 1)[0]?.toLowerCase();
  if (host !== PRODUCTION_HOST) return NextResponse.next();

  if (process.env.SHAPES_SITE_MODE !== "landing") {
    return new NextResponse("Production deployment is not in landing mode.", { status: 503 });
  }

  const path = request.nextUrl.pathname;
  if (PUBLIC_FILES.has(path) || path.startsWith("/_next/")) return NextResponse.next();
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: "/:path*",
};
