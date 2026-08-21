import * as XLSX from "xlsx";
import { readWorkbook, sniff } from "../lib/workbook.js";
import { parseStatementRows } from "../lib/statement.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

const HEADER = ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"];
const DATA = [
  ["20/08/26", "UPI/DR/451234567890/SWIGGY/YESB/swiggy@ybl", "450.00", "", "42150.00"],
  ["19/08/26", "NEFT/CITIN12345/ACME CONSULTING PVT", "", "85000.00", "42600.00"],
];

const build = (bookType) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Account Statement"], ["Account No: 501000123456"], [],
    HEADER, ...DATA,
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType }));
};

const expect = (label, buffer, wantFormat) => {
  check(`${label} sniffs as ${wantFormat}`, sniff(buffer), wantFormat);
  const { rows } = readWorkbook(buffer);
  const out = parseStatementRows(rows);
  check(`${label} parses two rows`, out.txns.length, 2);
  check(`${label} debit`, [out.txns[0].type, out.txns[0].amount, out.txns[0].date],
    ["debit", 450, "2026-08-20"]);
  check(`${label} credit`, [out.txns[1].type, out.txns[1].amount], ["credit", 85000]);
  check(`${label} merchant`, out.txns[0].merchant, "swiggy");
};

// The format the app already handled.
expect("xlsx", build("xlsx"), "xlsx");

// Genuine last-century BIFF8, which is what "legacy .xls" really means.
expect("legacy xls", build("biff8"), "xls");

// Indian banks very often ship an HTML table named .xls.
const html = Buffer.from(`<html><body><table>
<tr><td>Account Statement</td></tr>
<tr>${HEADER.map(h=>`<th>${h}</th>`).join("")}</tr>
${DATA.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("")}
</table></body></html>`, "utf8");
expect("html named .xls", html, "html");

// Tab separated text named .xls.
const tsv = Buffer.from(
  ["Account Statement", "", HEADER.join("\t"), ...DATA.map(r => r.join("\t"))].join("\n"), "utf8");
expect("tab separated", tsv, "text");

// Semicolon separated, common in European-locale exports.
const semi = Buffer.from(
  ["Account Statement", "", HEADER.join(";"), ...DATA.map(r => r.join(";"))].join("\n"), "utf8");
check("semicolon sniffs as text", sniff(semi), "text");
check("semicolon parses", parseStatementRows(readWorkbook(semi).rows).txns.length, 2);

// Plain CSV still works.
const csv = Buffer.from(
  [HEADER.join(","), ...DATA.map(r => r.map(c => /,/.test(c) ? `"${c}"` : c).join(","))].join("\n"), "utf8");
check("csv parses", parseStatementRows(readWorkbook(csv).rows).txns.length, 2);

// A file that is not a statement at all fails cleanly rather than throwing.
const junk = Buffer.from("hello there\nnothing here\n", "utf8");
check("junk reports an error", !!parseStatementRows(readWorkbook(junk).rows).error, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
