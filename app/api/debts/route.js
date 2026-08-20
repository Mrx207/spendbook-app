import { ensureSchema, sql } from "@/lib/db";
import { uid } from "@/lib/parser";

export const runtime = "nodejs";

export async function GET() {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM debts ORDER BY outstanding DESC, created_at DESC`;
  return Response.json({ debts: rows });
}

export async function POST(req) {
  await ensureSchema();
  const d = await req.json().catch(() => ({}));
  const name = (d.name || "").trim();
  const principal = Number(d.principal);
  if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
  if (!(principal > 0)) return Response.json({ error: "Amount must be greater than zero" }, { status: 400 });

  const id = uid();
  // A new borrowing starts with the whole principal still owed.
  await sql`INSERT INTO debts (id,name,kind,principal,outstanding,note)
    VALUES (${id},${name},${d.kind || "loan"},${principal},${principal},${d.note || ""})`;
  return Response.json({ id });
}

// Records a repayment against a debt. Never goes below zero, so an overpayment
// closes the debt instead of flipping it into a negative balance.
export async function PATCH(req) {
  await ensureSchema();
  const { id, paid } = await req.json().catch(() => ({}));
  const amount = Number(paid);
  if (!id) return Response.json({ error: "Missing debt id" }, { status: 400 });
  if (!(amount > 0)) return Response.json({ error: "Amount must be greater than zero" }, { status: 400 });

  const { rows } = await sql`UPDATE debts SET outstanding = GREATEST(outstanding - ${amount}, 0)
    WHERE id = ${id} RETURNING outstanding`;
  if (!rows.length) return Response.json({ error: "Debt not found" }, { status: 404 });
  return Response.json({ outstanding: Number(rows[0].outstanding) });
}

export async function DELETE(req) {
  await ensureSchema();
  const { id } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: "Missing debt id" }, { status: 400 });
  await sql`DELETE FROM debts WHERE id = ${id}`;
  return Response.json({ ok: true });
}
