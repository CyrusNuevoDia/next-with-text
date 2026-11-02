import { type NextRequest, NextResponse } from "next/server"

export default function proxy(request: NextRequest) {
  if (!request.cookies.get("session")) {
    return new NextResponse("Session required", { status: 401 })
  }
  return NextResponse.next()
}

export const config = { matcher: ["/protected/:path*"] }
