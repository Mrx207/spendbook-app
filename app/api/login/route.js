import { makeToken, safeEqual } from "@/lib/auth";

export const runtime = "nodejs";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(req) {
  const { password } = await req.json().catch(() => ({}));
  const expected = process.env.APP_PASSWORD;
  const secret = process.env.AUTH_SECRET;

  if (!expected || !secret) {
    return Response.json({ error: "Auth is not configured" }, { status: 500 });
  }
  if (typeof password !== "string" || !safeEqual(password, expected)) {
    return Response.json({ error: "Wrong password" }, { status: 401 });
  }

  const token = await makeToken(secret, WEEK_MS);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `sb_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${WEEK_MS / 1000}`,
    },
  });
}
