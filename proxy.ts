import { NextRequest, NextResponse } from "next/server";

function unauthorized(message = "TokenDance Field requires authentication.") {
  return new NextResponse(message, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="TokenDance Field", charset="UTF-8"', "Cache-Control": "no-store" } });
}

export function proxy(request: NextRequest) {
  const username = process.env.FIELD_ACCESS_USER;
  const password = process.env.FIELD_ACCESS_PASSWORD;
  if (!username || !password) return new NextResponse("TokenDance Field access credentials are not configured.", { status: 503 });
  const expected = `Basic ${btoa(`${username}:${password}`)}`;
  if (request.headers.get("authorization") !== expected) return unauthorized();
  const response = NextResponse.next();
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.svg|og.png|api/health).*)"] };
