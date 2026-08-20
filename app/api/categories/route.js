import { ensureSchema, sql } from "@/lib/db";

export const runtime = "nodejs";

const KINDS = new Set(["expense", "income", "transfer"]);

// Ids are slugs so they read sensibly in the data and stay stable across
// renames - the display name can change without orphaning transactions.
const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "cat";

async function freeId(base) {
  for (let i = 0; i < 50; i++) {
    const id = i ? `${base}${i + 1}` : base;
    const { rows } = await sql`SELECT 1 FROM categories WHERE id = ${id}`;
    if (!rows.length) return id;
  }
  return `${base}${Date.now().toString(36).slice(-4)}`;
}

export async function POST(req) {
  await ensureSchema();
  const c = await req.json().catch(() => ({}));
  const name = (c.name || "").trim();
  if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
  if (!KINDS.has(c.kind)) return Response.json({ error: "Pick what this counts as" }, { status: 400 });

  const { rows: clash } = await sql`SELECT id FROM categories WHERE lower(name) = ${name.toLowerCase()}`;
  if (clash.length) return Response.json({ error: `“${name}” already exists` }, { status: 409 });

  const id = await freeId(slugify(name));
  await sql`INSERT INTO categories (id,name,icon,color,budget,excluded,kind,custom)
    VALUES (${id},${name},${c.icon || "🏷️"},${c.color || "#6B7A93"},0,FALSE,${c.kind},TRUE)`;
  return Response.json({ id, name, kind: c.kind });
}

export async function PATCH(req) {
  await ensureSchema();
  const c = await req.json().catch(() => ({}));
  if (!c.id) return Response.json({ error: "Missing category id" }, { status: 400 });

  const { rows } = await sql`SELECT * FROM categories WHERE id = ${c.id}`;
  if (!rows.length) return Response.json({ error: "Category not found" }, { status: 404 });
  const existing = rows[0];

  const name = (c.name || "").trim() || existing.name;
  const { rows: clash } = await sql`SELECT id FROM categories WHERE lower(name) = ${name.toLowerCase()} AND id <> ${c.id}`;
  if (clash.length) return Response.json({ error: `“${name}” already exists` }, { status: 409 });

  // The shipped categories keep their kind: the totals model depends on a card
  // bill being a transfer and salary being income, and re-seeding would undo
  // any change anyway. Renaming and recolouring stay open.
  let kind = existing.kind;
  if (c.kind && KINDS.has(c.kind) && existing.custom) kind = c.kind;
  else if (c.kind && c.kind !== existing.kind && !existing.custom) {
    return Response.json({ error: "Built-in categories keep their type. Make your own to choose." }, { status: 400 });
  }

  await sql`UPDATE categories SET name = ${name}, icon = ${c.icon || existing.icon},
    color = ${c.color || existing.color}, kind = ${kind} WHERE id = ${c.id}`;
  // Rows already filed here follow the category if its type changed.
  if (kind !== existing.kind) {
    await sql`UPDATE transactions SET kind = ${kind} WHERE category_id = ${c.id}`;
  }
  return Response.json({ ok: true, kind });
}

export async function DELETE(req) {
  await ensureSchema();
  const { id } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: "Missing category id" }, { status: 400 });

  const { rows } = await sql`SELECT custom FROM categories WHERE id = ${id}`;
  if (!rows.length) return Response.json({ error: "Category not found" }, { status: 404 });
  if (!rows[0].custom) {
    return Response.json({ error: "Built-in categories can't be deleted" }, { status: 400 });
  }

  // Nothing is lost - transactions fall back to Uncategorised rather than
  // pointing at a category that no longer exists.
  const moved = await sql`UPDATE transactions SET category_id = 'other', kind = 'expense' WHERE category_id = ${id}`;
  await sql`DELETE FROM rules WHERE category_id = ${id}`;
  await sql`DELETE FROM categories WHERE id = ${id}`;
  return Response.json({ ok: true, moved: moved.rowCount });
}
