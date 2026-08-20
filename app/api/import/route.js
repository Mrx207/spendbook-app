import ExcelJS from "exceljs";
import { ensureSchema, sql } from "@/lib/db";
import { categorise, dupStatus } from "@/lib/parser";
import { parseStatementRows, parseCSV } from "@/lib/statement";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 8 * 1024 * 1024;

async function rowsFromXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = [];
    // ExcelJS values are 1-based with a leading hole at index 0.
    row.eachCell({ includeEmpty: true }, (c, col) => {
      let v = c.value;
      if (v && typeof v === "object") {
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        else if (v.text !== undefined) v = v.text;
        else if (v.result !== undefined) v = v.result;
        else if (v.richText) v = v.richText.map(t => t.text).join("");
        else v = "";
      }
      values[col - 1] = v === null || v === undefined ? "" : v;
    });
    rows.push(values);
  });
  return rows;
}

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

  const name = String(file.name || "").toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  let rows;
  try {
    if (name.endsWith(".csv") || name.endsWith(".txt")) {
      rows = parseCSV(buffer.toString("utf8"));
    } else if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
      rows = await rowsFromXlsx(buffer);
    } else {
      return Response.json(
        { error: "Upload a .csv or .xlsx file. Legacy .xls is not supported - re-save it as .xlsx." },
        { status: 415 },
      );
    }
  } catch {
    return Response.json({ error: "That file could not be read" }, { status: 400 });
  }

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
