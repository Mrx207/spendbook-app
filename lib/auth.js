// Session tokens for the password gate. Uses Web Crypto so the same helpers
// work in the Edge middleware and in the Node route handler.

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
}

async function sign(payload, secret) {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload)));
}

// Compares without leaking where the mismatch is via timing.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Token is "<expiry ms>.<hmac of expiry>" - self-contained, no server state.
export async function makeToken(secret, ttlMs) {
  const exp = String(Date.now() + ttlMs);
  return `${exp}.${await sign(exp, secret)}`;
}

export async function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  return safeEqual(sig, await sign(exp, secret));
}
