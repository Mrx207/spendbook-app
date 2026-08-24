import { ensureSchema, sql, query } from "@/lib/db";
import { uid, categorise } from "@/lib/parser";
import { toISODate } from "@/lib/dates";

export const runtime = "nodejs";

// A remembered merchant becomes a rule pattern, so anything regex-special in
// the name has to be neutralised or it will match the wrong rows later.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function GET() {
  await ensureSchema();
  const [{ rows: txns }, { rows: categories }, { rows: accounts }, { rows: rules }, { rows: rates }, { rows: debts }] = await Promise.all([
    // High enough that a full history arrives intact; the old cap silently
    // hid rows once the ledger outgrew it, which quietly wrongs every total.
    sql`SELECT * FROM transactions ORDER BY date DESC, time DESC NULLS LAST, created_at DESC LIMIT 20000`,
    sql`SELECT * FROM categories`, sql`SELECT * FROM accounts`, sql`SELECT * FROM rules`,
    sql`SELECT * FROM rates`,
    sql`SELECT * FROM debts ORDER BY outstanding DESC, created_at DESC`,
  ]);
  return Response.json({ txns, categories, accounts, rules, rates, debts });
}

const COLS = ["id","type","amount","date","time","merchant","note","category_id",
  "account_id","source","ref","raw","fx_amount","fx_currency","estimated","kind","person","balance"];

const toRow = (t, fallbackSource, catKind) => [
  t.id || uid(), t.type, t.amount, t.date, t.time || "", t.merchant || "Unknown", t.note || "",
  t.category_id ?? t.categoryId ?? null, t.account_id ?? t.accountId ?? null,
  t.source || fallbackSource, t.ref || null, t.raw || "",
  t.fxAmount ?? null, t.fxCurrency ?? null, !!t.estimated,
  // Resolved server-side from the category, so a client can't post a row whose
  // kind disagrees with its category and skew the totals.
  catKind[t.category_id ?? t.categoryId] || (t.type === "credit" ? "income" : "expense"),
  (t.person || "").trim() || null,
  t.balance ?? null,
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

  // The client flags duplicates in the preview, but it can be overridden there,
  // and nothing stops the same file being imported twice. The ledger is the
  // authority on what it already holds, so the check is repeated here.
  const { rows: existing } = await sql`SELECT date, amount, type, merchant, ref FROM transactions`;
  const fingerprint = (date, amount, type, merchant) =>
    `${toISODate(date)}|${Number(amount).toFixed(2)}|${type}|${String(merchant||"").trim().toLowerCase()}`;

  const seen = new Set(existing.map(e => fingerprint(e.date, e.amount, e.type, e.merchant)));
  const refs = new Set(existing.filter(e => e.ref).map(e => String(e.ref).toUpperCase()));

  const fresh = [];
  let duplicates = 0;
  for (const t of valid) {
    const fp = fingerprint(t.date, t.amount, t.type, t.merchant);
    const ref = t.ref ? String(t.ref).toUpperCase() : null;
    if (seen.has(fp) || (ref && refs.has(ref))) { duplicates++; continue; }
    seen.add(fp);
    if (ref) refs.add(ref);
    fresh.push(t);
  }
  if (!fresh.length) return Response.json({ added: 0, duplicates });

  const rows = fresh.map(t => toRow(t, Array.isArray(body.txns) ? "statement" : "manual", catKind));

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
  return Response.json({ added, duplicates });
}

// Edits from the transaction sheet. Only the fields worth correcting by hand
// are writable; `kind` is re-derived from the new category rather than trusted
// from the client, so the totals can never disagree with the category shown.
export async function PATCH(req) {
  await ensureSchema();
  const t = await req.json().catch(() => null);
  if (!t?.id) return Response.json({ error: "Missing transaction id" }, { status: 400 });

  const { rows: cats } = await sql`SELECT id, kind FROM categories WHERE id = ${t.category_id}`;
  if (!cats.length) return Response.json({ error: "Unknown category" }, { status: 400 });
  const kind = cats[0].kind;

  const amount = Number(t.amount);
  if (!(amount > 0)) return Response.json({ error: "Amount must be greater than zero" }, { status: 400 });

  // A person only belongs on a lending row; clearing it elsewhere stops stale
  // names from haunting the People balances after a recategorise.
  const person = t.category_id === "people" ? (t.person || "").trim() || null : null;

  const merchant = (t.merchant || "").trim() || "Unknown";

  await sql`UPDATE transactions SET
    amount = ${amount},
    type = ${t.type === "credit" ? "credit" : "debit"},
    merchant = ${merchant},
    note = ${t.note || ""},
    category_id = ${t.category_id},
    person = ${person},
    kind = ${kind}
    WHERE id = ${t.id}`;

  // Filing one row by hand is fine; filing six hundred is not. Remembering the
  // decision turns a correction into a rule that also cleans up the backlog.
  let alsoFixed = 0;
  if (t.applyToSimilar && merchant !== "Unknown") {
    const pattern = escapeRegex(merchant.toLowerCase());
    await sql`INSERT INTO rules (id, pattern, category_id, source)
      VALUES (${"u" + uid()}, ${pattern}, ${t.category_id}, 'user')
      ON CONFLICT (id) DO NOTHING`;

    // Only rows the user has not already filed deliberately are swept up.
    const res = await sql`UPDATE transactions SET category_id = ${t.category_id}, kind = ${kind}, person = ${person}
      WHERE lower(merchant) = ${merchant.toLowerCase()}
        AND id <> ${t.id}
        AND category_id IN ('other','income')`;
    alsoFixed = res.rowCount;
  }

  return Response.json({ ok: true, kind, alsoFixed });
}

export async function DELETE(req) {
  await ensureSchema();
  const { id } = await req.json();
  await sql`DELETE FROM transactions WHERE id=${id}`;
  return Response.json({ ok: true });
}
