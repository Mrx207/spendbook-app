import { ensureSchema, sql } from "@/lib/db";
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

// Manual add from the dashboard
export async function POST(req) {
  await ensureSchema();
  const t = await req.json();
  const id = uid();
  await sql`INSERT INTO transactions
    (id,type,amount,date,time,merchant,note,category_id,account_id,source,ref,raw,fx_amount,fx_currency,estimated)
    VALUES (${id},${t.type},${t.amount},${t.date},${t.time||""},${t.merchant},${t.note||""},
      ${t.categoryId},${t.accountId},${"manual"},${null},${""},${null},${null},${false})`;
  return Response.json({ id });
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
