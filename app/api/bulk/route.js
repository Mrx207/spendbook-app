import { ensureSchema, sql, query } from "@/lib/db";
import { uid } from "@/lib/parser";

export const runtime = "nodejs";
export const maxDuration = 60;

// Files many transactions at once. The previous category of every row is kept
// so the whole move can be reversed - filing 121 entries by accident should
// cost one tap to fix, not an evening.
export async function POST(req) {
  await ensureSchema();
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
  if (!ids.length) return Response.json({ error: "Nothing selected" }, { status: 400 });
  if (!body.category_id) return Response.json({ error: "Pick a category" }, { status: 400 });

  const { rows: cats } = await sql`SELECT kind FROM categories WHERE id = ${body.category_id}`;
  if (!cats.length) return Response.json({ error: "Unknown category" }, { status: 400 });
  const kind = cats[0].kind;
  const person = body.category_id === "people" ? (body.person || "").trim() || null : null;

  const { rows: before } = await query(
    `SELECT id, category_id, kind, person FROM transactions WHERE id = ANY($1)`, [ids],
  );
  if (!before.length) return Response.json({ error: "Nothing to change" }, { status: 404 });

  const res = await query(
    `UPDATE transactions SET category_id = $1, kind = $2, person = $3 WHERE id = ANY($4)`,
    [body.category_id, kind, person, ids],
  );

  const undoId = uid();
  await sql`INSERT INTO undo_log (id, label, payload)
    VALUES (${undoId}, ${body.label || `Filed ${res.rowCount} entries`}, ${JSON.stringify(before)})`;
  // Only the most recent handful is worth keeping around.
  await sql`DELETE FROM undo_log WHERE id NOT IN (SELECT id FROM undo_log ORDER BY created_at DESC LIMIT 5)`;

  // Remembering the decision means the next import files itself.
  if (body.remember && body.merchant) {
    const pattern = String(body.merchant).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await sql`INSERT INTO rules (id, pattern, category_id, source)
      VALUES (${"u" + uid()}, ${pattern}, ${body.category_id}, 'user') ON CONFLICT (id) DO NOTHING`;
  }

  return Response.json({ updated: res.rowCount, undoId, kind });
}

// Reverses the most recent bulk change.
export async function DELETE(req) {
  await ensureSchema();
  const { undoId } = await req.json().catch(() => ({}));

  const { rows } = undoId
    ? await sql`SELECT * FROM undo_log WHERE id = ${undoId}`
    : await sql`SELECT * FROM undo_log ORDER BY created_at DESC LIMIT 1`;
  if (!rows.length) return Response.json({ error: "Nothing to undo" }, { status: 404 });

  const entry = rows[0];
  const payload = typeof entry.payload === "string" ? JSON.parse(entry.payload) : entry.payload;

  // Two shapes: a categorise records the previous values to write back, while a
  // cleanup records whole rows that have to be put back.
  let restored = 0;
  if (Array.isArray(payload)) {
    for (const r of payload) {
      await sql`UPDATE transactions SET category_id = ${r.category_id}, kind = ${r.kind}, person = ${r.person}
        WHERE id = ${r.id}`;
      restored++;
    }
  } else if (payload?.deleted) {
    for (const t of payload.deleted) {
      await sql`INSERT INTO transactions
        (id,type,amount,date,time,merchant,note,category_id,account_id,source,ref,raw,fx_amount,fx_currency,estimated,kind,person)
        VALUES (${t.id},${t.type},${t.amount},${t.date},${t.time},${t.merchant},${t.note},${t.category_id},
          ${t.account_id},${t.source},${t.ref},${t.raw},${t.fx_amount},${t.fx_currency},${t.estimated},${t.kind},${t.person})
        ON CONFLICT (id) DO NOTHING`;
      restored++;
    }
  }

  await sql`DELETE FROM undo_log WHERE id = ${entry.id}`;
  return Response.json({ restored, label: entry.label });
}
