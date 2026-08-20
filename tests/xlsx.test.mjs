import ExcelJS from "exceljs";
import { parseStatementRows } from "../lib/statement.js";

// Mirrors rowsFromXlsx in app/api/import/route.js
async function rowsFromXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = [];
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

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Statement");
ws.addRow(["Axis Bank Statement"]);
ws.addRow(["Account: 91801000123456"]);
ws.addRow([]);
ws.addRow(["Tran Date", "Particulars", "Debit", "Credit", "Balance"]);
ws.addRow([new Date("2026-08-20"), "UPI/DR/9988776655/ZOMATO/HDFC/zomato@hdfc", 320.5, null, 41000]);
ws.addRow([new Date("2026-08-19"), "IMPS/P2A/RAHUL SHARMA", null, 5000, 41320.5]);
ws.addRow(["18/08/2026", "POS/BIG BAZAAR MUMBAI", 1875, null, 36320.5]);

const buf = await wb.xlsx.writeBuffer();
const rows = await rowsFromXlsx(Buffer.from(buf));
const out = parseStatementRows(rows);

console.log("error:", out.error || "none");
console.log("parsed:", out.txns.length, "skipped:", out.skipped);
for (const t of out.txns) {
  console.log(` ${t.date}  ${t.type.padEnd(6)} ${String(t.amount).padStart(9)}  ${t.merchant}`);
}

const ok =
  !out.error &&
  out.txns.length === 3 &&
  out.txns[0].type === "debit" && out.txns[0].amount === 320.5 && out.txns[0].date === "2026-08-20" &&
  out.txns[1].type === "credit" && out.txns[1].amount === 5000 &&
  out.txns[2].type === "debit" && out.txns[2].amount === 1875 && out.txns[2].date === "2026-08-18";

console.log(ok ? "\nXLSX OK" : "\nXLSX FAILED");
process.exit(ok ? 0 : 1);
