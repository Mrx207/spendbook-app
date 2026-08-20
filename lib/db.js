import { Pool } from "pg";

// This DB isn't Neon, so @vercel/postgres's WebSocket-based driver hangs
// forever on connect. Plain `pg` speaks standard Postgres wire protocol
// instead. Lazily created so module import (e.g. during Next's build-time
// page-data collection, when the env var isn't injected) doesn't fail.
let _pool;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}

// Mimics the @vercel/postgres tagged-template `sql` API used throughout this
// app: sql`SELECT * FROM t WHERE id = ${id}` -> { rows }.
export function sql(strings, ...values) {
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
  return getPool().query(text, values);
}

// For statements whose shape is built at runtime, e.g. multi-row inserts.
export function query(text, values) {
  return getPool().query(text, values);
}

// Bump when DEFAULT_RULES changes so existing ledgers re-seed the shipped set.
const RULES_VERSION = "2";

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
  // Added after the first release, so they have to be patched in rather than
  // assumed. `kind` splits net-worth effect from what was bought.
  await sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'expense'`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS kind TEXT`;
  // Who the money was lent to or borrowed from, for the People balances.
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS person TEXT`;

  // Formal borrowings - loans, cards, anything with an outstanding balance.
  // Tracked by hand because no statement line states what you still owe.
  await sql`CREATE TABLE IF NOT EXISTS debts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'loan',
    principal NUMERIC NOT NULL DEFAULT 0, outstanding NUMERIC NOT NULL DEFAULT 0,
    note TEXT, created_at TIMESTAMPTZ DEFAULT now()
  )`;

  const { DEFAULT_CATEGORIES, DEFAULT_RULES, DEFAULT_RATES } = await import("./parser.js");

  // Categories that predate `kind`, or that ship in a later version, are
  // reconciled every cold start - cheap, and keeps old ledgers correct.
  for (const c of DEFAULT_CATEGORIES) {
    await sql`INSERT INTO categories (id,name,icon,color,budget,excluded,kind)
      VALUES (${c.id},${c.name},${c.icon},${c.color},${c.budget},${!!c.excluded},${c.kind})
      ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, excluded = EXCLUDED.excluded`;
  }
  // Backfill transactions stored before the column existed.
  await sql`UPDATE transactions t SET kind = COALESCE(c.kind, CASE WHEN t.type='credit' THEN 'income' ELSE 'expense' END)
    FROM categories c WHERE t.category_id = c.id AND t.kind IS NULL`;
  await sql`UPDATE transactions SET kind = CASE WHEN type='credit' THEN 'income' ELSE 'expense' END WHERE kind IS NULL`;

  // The shipped rules change between releases. Version them so an existing
  // ledger picks up corrections instead of keeping the rules it seeded with,
  // while anything the user adds later survives untouched.
  await sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  await sql`ALTER TABLE rules ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'default'`;

  const { rows: seeded } = await sql`SELECT value FROM meta WHERE key = 'rules_version'`;
  if (seeded[0]?.value !== RULES_VERSION) {
    await sql`DELETE FROM rules WHERE source = 'default'`;
    for (const [pattern, categoryId] of DEFAULT_RULES) {
      await sql`INSERT INTO rules (id,pattern,category_id,source)
        VALUES (${pattern.slice(0,20)+Math.random().toString(36).slice(2,6)},${pattern},${categoryId},'default')`;
    }
    await sql`INSERT INTO meta (key,value) VALUES ('rules_version',${RULES_VERSION})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  }

  for (const [cur, rate] of Object.entries(DEFAULT_RATES)) {
    await sql`INSERT INTO rates (currency, rate) VALUES (${cur},${rate}) ON CONFLICT (currency) DO NOTHING`;
  }
  await sql`INSERT INTO accounts (id,name,type,last4,color)
    VALUES ('cash','Cash','cash','{}','#A0A6B0') ON CONFLICT (id) DO NOTHING`;
}
