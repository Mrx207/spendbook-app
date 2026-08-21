import { ensureSchema, sql } from "@/lib/db";
import { categorise, dupStatus } from "@/lib/parser";
import { parseStatementRows } from "@/lib/statement";
import { readWorkbook } from "@/lib/workbook";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 8 * 1024 * 1024;

// Parses an uploaded statement and returns drafts. Nothing is written here -
// the user confirms the preview first, then the rows go through POST.
export async function POST(req) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return Response.json({ error: "No file uploaded" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "File is larger than 8MB" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) return Response.json({ error: "That file is empty" }, { status: 400 });

  let rows;
  try {
    ({ rows } = readWorkbook(buffer));
  } catch {
    return Response.json({ error: "That file could not be read" }, { status: 400 });
  }
  if (!rows.length) return Response.json({ error: "That file has no rows in it" }, { status: 422 });

  const parsed = parseStatementRows(rows);
  if (parsed.error) return Response.json({ error: parsed.error }, { status: 422 });
  if (!parsed.txns.length) {
    return Response.json({ error: "No transactions found in that file" }, { status: 422 });
  }

  await ensureSchema();
  const [{ rows: categories }, { rows: rules }, { rows: existing }] = await Promise.all([
    sql`SELECT * FROM categories`,
    sql`SELECT * FROM rules`,
    sql`SELECT id, ref, amount, type, date, merchant, account_id FROM transactions`,
  ]);

  // Compare against the ledger and against earlier rows in this same file, so a
  // statement that overlaps a previous import doesn't double-count.
  const ruleList = rules.map(r => ({ pattern: r.pattern, categoryId: r.category_id }));
  const seen = [];
  const draft = parsed.txns.map((txn) => {
    txn.category_id = categorise(txn, ruleList, categories);
    const status = dupStatus(txn, [...existing.map(e => ({ ...e, amount: Number(e.amount) })), ...seen]);
    seen.push(txn);
    return { txn, dup: status, keep: status === "new" };
  });

  return Response.json({ draft, skipped: parsed.skipped, total: parsed.txns.length });
}
