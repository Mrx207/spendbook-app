import { ensureSchema, sql, query } from "@/lib/db";
import { uid } from "@/lib/parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Two rows are the same event when the day, amount, direction and counterparty
// all agree. Reference numbers are compared separately, since a bank that
// supplies one has already told us the transactions are distinct.
const GROUPS = `
  SELECT array_agg(id ORDER BY created_at, id) AS ids,
         count(*) AS n, min(date) AS date, min(amount) AS amount,
         min(merchant) AS merchant, min(type) AS type
  FROM transactions
  GROUP BY date, amount, type, lower(trim(coalesce(merchant,''))),
           coalesce(nullif(upper(trim(coalesce(ref,''))), ''), '~')
  HAVING count(*) > 1
`;

// Reports what would be removed, without touching anything.
export async function GET() {
  await ensureSchema();
  const { rows } = await query(GROUPS);
  const extra = rows.reduce((s, r) => s + (Number(r.n) - 1), 0);
  const value = rows.reduce((s, r) => s + Number(r.amount) * (Number(r.n) - 1), 0);
  return Response.json({
    groups: rows.length,
    extra,
    value,
    sample: rows
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 12)
      .map(r => ({
        date: String(r.date).slice(0, 10), amount: Number(r.amount),
        merchant: r.merchant, copies: Number(r.n),
      })),
  });
}

// Keeps the earliest copy of each group and removes the rest. Recorded in the
// undo log first, so a mistaken cleanup can be reversed like any bulk change.
export async function POST() {
  await ensureSchema();
  const { rows } = await query(GROUPS);
  if (!rows.length) return Response.json({ removed: 0 });

  const doomed = rows.flatMap(r => r.ids.slice(1));
  if (!doomed.length) return Response.json({ removed: 0 });

  const { rows: snapshot } = await query(
    `SELECT * FROM transactions WHERE id = ANY($1)`, [doomed],
  );
  const undoId = uid();
  await sql`INSERT INTO undo_log (id, label, payload)
    VALUES (${undoId}, ${`Removed ${doomed.length} duplicates`}, ${JSON.stringify({ deleted: snapshot })})`;
  await sql`DELETE FROM undo_log WHERE id NOT IN (SELECT id FROM undo_log ORDER BY created_at DESC LIMIT 5)`;

  const res = await query(`DELETE FROM transactions WHERE id = ANY($1)`, [doomed]);
  return Response.json({ removed: res.rowCount, undoId });
}
