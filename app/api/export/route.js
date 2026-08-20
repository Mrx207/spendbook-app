import { ensureSchema, sql } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;
// Reads the ledger on every request; without this Next tries to render it at
// build time, when there is no database to talk to.
export const dynamic = "force-dynamic";

// Quotes a field for CSV: doubles any quotes and wraps anything containing a
// separator, so a narration with a comma can't shift every later column.
const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// The driver hands DATE columns back as Date objects, whose default string
// form is a locale stamp ("Thu Aug 20"), not something a spreadsheet can sort.
const isoDate = (v) => {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v ?? "").slice(0, 10);
};

const COLUMNS = [
  ["date", t => isoDate(t.date)],
  ["type", t => t.type],
  ["kind", t => t.kind],
  ["amount", t => t.amount],
  ["merchant", t => t.merchant],
  ["category", t => t.category_name || t.category_id],
  ["person", t => t.person],
  ["note", t => t.note],
  ["account", t => t.account_name || ""],
  ["source", t => t.source],
  ["reference", t => t.ref],
  ["original_text", t => t.raw],
];

export async function GET() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT t.*, c.name AS category_name, a.name AS account_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    ORDER BY t.date DESC, t.created_at DESC`;

  const lines = [COLUMNS.map(([h]) => h).join(",")];
  for (const t of rows) lines.push(COLUMNS.map(([, get]) => cell(get(t))).join(","));

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response("﻿" + lines.join("\r\n"), {
    headers: {
      // The BOM makes Excel read it as UTF-8 rather than mangling the rupee sign.
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="spendbook-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
