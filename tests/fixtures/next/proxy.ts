import { type NextRequest, NextResponse } from "next/server"

export default function proxy(req: NextRequest) {
  if (!req.cookies.get("session")) {
    return NextResponse.redirect(new URL("/", req.url))
  }
}

export const config = { matcher: ["/admin/:path*"] }
