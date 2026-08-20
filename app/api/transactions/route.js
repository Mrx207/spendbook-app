import { ensureSchema, sql, query } from "@/lib/db";
import { uid, categorise } from "@/lib/parser";

export const runtime = "nodejs";

export async function GET() {
  await ensureSchema();
  const [{ rows: txns }, { rows: categories }, { rows: accounts }, { rows: rules }, { rows: rates }] = await Promise.all([
    sql`SELECT * FROM transactions ORDER BY date DESC, time DESC NULLS LAST, created_at DESC LIMIT 2000`,
    sql`SELECT * FROM categories`, sql`SELECT * FROM accounts`, sql`SELECT * FROM rules`,
    sql`SELECT * FROM rates`,
  ]);
  return Response.json({ txns, categories, accounts, rules, rates });
}

const COLS = ["id","type","amount","date","time","merchant","note","category_id",
  "account_id","source","ref","raw","fx_amount","fx_currency","estimated","kind"];

const toRow = (t, fallbackSource, catKind) => [
  t.id || uid(), t.type, t.amount, t.date, t.time || "", t.merchant || "Unknown", t.note || "",
  t.category_id ?? t.categoryId ?? null, t.account_id ?? t.accountId ?? null,
  t.source || fallbackSource, t.ref || null, t.raw || "",
  t.fxAmount ?? null, t.fxCurrency ?? null, !!t.estimated,
  // Resolved server-side from the category, so a client can't post a row whose
  // kind disagrees with its category and skew the totals.
  catKind[t.category_id ?? t.categoryId] || (t.type === "credit" ? "income" : "expense"),
];

// Accepts either a single transaction or { txns: [...] } from an import.
// Statements run to hundreds of rows, so they go in as one multi-row insert
// rather than a request per row.
export async function POST(req) {
  await ensureSchema();
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Bad request body" }, { status: 400 });

  const list = Array.isArray(body.txns) ? body.txns : [body];
  const valid = list.filter(t => t && t.type && t.date && Number(t.amount) > 0);
  if (!valid.length) return Response.json({ error: "No valid transactions" }, { status: 400 });

  const { rows: cats } = await sql`SELECT id, kind FROM categories`;
  const catKind = Object.fromEntries(cats.map(c => [c.id, c.kind]));
  const rows = valid.map(t => toRow(t, Array.isArray(body.txns) ? "statement" : "manual", catKind));

  // Chunked to stay well under Postgres' bind-parameter ceiling.
  const perChunk = Math.floor(30000 / COLS.length);
  let added = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const values = [];
    const tuples = chunk.map((row, r) =>
      `(${row.map((v, c) => { values.push(v); return `$${r * COLS.length + c + 1}`; }).join(",")})`
    );
    const res = await query(
      `INSERT INTO transactions (${COLS.join(",")}) VALUES ${tuples.join(",")} ON CONFLICT (id) DO NOTHING`,
      values,
    );
    added += res.rowCount;
  }
  return Response.json({ added });
}

export async function PATCH(req) {
  await ensureSchema();
  const t = await req.json();
  await sql`UPDATE transactions SET type=${t.type}, amount=${t.amount}, date=${t.date}, time=${t.time||""},
    merchant=${t.merchant}, note=${t.note||""}, category_id=${t.categoryId}, account_id=${t.accountId}
    WHERE id=${t.id}`;
  return Response.json({ ok: true });
}

export async function DELETE(req) {
  await ensureSchema();
  const { id } = await req.json();
  await sql`DELETE FROM transactions WHERE id=${id}`;
  return Response.json({ ok: true });
}
