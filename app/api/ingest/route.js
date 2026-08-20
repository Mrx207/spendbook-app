import { ensureSchema, sql } from "@/lib/db";
import { parseSMS, splitMessages, categorise, matchAccount, dupStatus, settle } from "@/lib/parser";

export const runtime = "nodejs";

// Shortcuts posts: { secret: "...", text: "raw SMS body" }
export async function POST(req) {
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Bad request body" }, { status: 400 });

  if (body.secret !== process.env.INGEST_SECRET) {
    return Response.json({ error: "Invalid secret" }, { status: 401 });
  }
  if (!body.text || typeof body.text !== "string") {
    return Response.json({ error: "Missing text" }, { status: 400 });
  }

  await ensureSchema();

  const [{ rows: accounts }, { rows: categories }, { rows: rules }, { rows: rateRows }] = await Promise.all([
    sql`SELECT * FROM accounts`, sql`SELECT * FROM categories`,
    sql`SELECT * FROM rules`, sql`SELECT * FROM rates`,
  ]);
  const rates = Object.fromEntries(rateRows.map(r => [r.currency, Number(r.rate)]));

  const parts = splitMessages(body.text);
  const parsed = parts.map(parseSMS).filter(Boolean);
  if (!parsed.length) return Response.json({ added: 0, skipped: parts.length, reason: "no transaction detected" });

  let added = 0, dupes = 0;
  for (const p of parsed) {
    const account_id = matchAccount(p.last4, p.hint, accounts.map(a => ({ ...a, last4: a.last4 || [] })));
    const acc = accounts.find(a => a.id === account_id);
    const s = settle(p.money, rates, acc?.markup ?? 3.5);
    if (!s) continue;
    const txn = { ...p, ...s, account_id };
    txn.category_id = categorise(txn, rules.map(r => ({ pattern: r.pattern, categoryId: r.category_id })), categories.map(c => ({ id: c.id })));

    const { rows: existing } = await sql`
      SELECT id, ref, amount, type, date, merchant, account_id FROM transactions
      WHERE date >= (${txn.date}::date - interval '1 day') AND date <= (${txn.date}::date + interval '1 day')
    `;
    const status = dupStatus(txn, existing);
    if (status === "exact") { dupes++; continue; }

    await sql`INSERT INTO transactions
      (id,type,amount,date,time,merchant,note,category_id,account_id,source,ref,raw,fx_amount,fx_currency,estimated)
      VALUES (${txn.id},${txn.type},${txn.amount},${txn.date},${txn.time},${txn.merchant},${txn.note||""},
        ${txn.category_id},${account_id},${"sms-webhook"},${txn.ref},${txn.raw},${txn.fxAmount},${txn.fxCurrency},${!!txn.estimated})`;
    added++;
  }

  return Response.json({ added, dupes_skipped: dupes, read: parts.length });
}
