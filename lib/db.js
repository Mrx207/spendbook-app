import { createClient } from "@vercel/postgres";

// POSTGRES_URL here is a direct (non-pooled) connection string; createClient()
// accepts that, unlike the default pooled-only `sql` export. Lazily created so
// module import (e.g. during Next's build-time page-data collection, when the
// env var isn't injected) doesn't fail.
let _client;
function getClient() {
  if (!_client) _client = createClient();
  return _client;
}
export function sql(strings, ...values) {
  return getClient().sql(strings, ...values);
}

// Runs once cheaply on every cold start - CREATE TABLE IF NOT EXISTS is idempotent.
export async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    last4 TEXT[] DEFAULT '{}', color TEXT, "limit" NUMERIC DEFAULT 0, markup NUMERIC DEFAULT 3.5
  )`;
  await sql`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, color TEXT,
    budget NUMERIC DEFAULT 0, excluded BOOLEAN DEFAULT FALSE
  )`;
  await sql`CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY, pattern TEXT NOT NULL, category_id TEXT NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS rates (currency TEXT PRIMARY KEY, rate NUMERIC NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, amount NUMERIC NOT NULL,
    date DATE NOT NULL, time TEXT, merchant TEXT, note TEXT,
    category_id TEXT, account_id TEXT, source TEXT, ref TEXT, raw TEXT,
    fx_amount NUMERIC, fx_currency TEXT, estimated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  const { rows } = await sql`SELECT count(*)::int AS n FROM categories`;
  if (rows[0].n === 0) {
    const { DEFAULT_CATEGORIES, DEFAULT_RULES, DEFAULT_RATES } = await import("./parser.js");
    for (const c of DEFAULT_CATEGORIES) {
      await sql`INSERT INTO categories (id,name,icon,color,budget,excluded) VALUES (${c.id},${c.name},${c.icon},${c.color},${c.budget},${!!c.excluded})`;
    }
    for (const [pattern, categoryId] of DEFAULT_RULES) {
      await sql`INSERT INTO rules (id,pattern,category_id) VALUES (${pattern.slice(0,20)+Math.random().toString(36).slice(2,6)},${pattern},${categoryId})`;
    }
    for (const [cur, rate] of Object.entries(DEFAULT_RATES)) {
      await sql`INSERT INTO rates (currency, rate) VALUES (${cur},${rate})`;
    }
    await sql`INSERT INTO accounts (id,name,type,last4,color) VALUES ('cash','Cash','cash','{}','#A0A6B0')`;
  }
}
