import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

// Everything except Next's own static output goes through the gate.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json).*)"],
};

// The SMS webhook authenticates with its own shared secret, so it stays open
// to the Shortcut that posts to it.
const OPEN_PATHS = new Set(["/login", "/api/login", "/api/ingest"]);

export async function middleware(req) {
  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.has(pathname)) return NextResponse.next();

  if (await verifyToken(req.cookies.get("sb_session")?.value, process.env.AUTH_SECRET)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}
