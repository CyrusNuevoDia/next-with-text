import { type NextRequest, NextResponse } from "next/server"

export default function proxy(req: NextRequest) {
  if (
    req.nextUrl.pathname.startsWith("/admin") &&
    !req.cookies.get("session")
  ) {
    return NextResponse.redirect(new URL("/", req.url))
  }
}

// The header-conditional matcher runs the proxy only for markdown requests, so
// it guards no route and must not drop any page from the llms surfaces.
export const config = {
  matcher: [
    "/admin/:path*",
    {
      has: [{ key: "accept", type: "header", value: ".*text/markdown.*" }],
      source: "/:path*",
    },
  ],
}
