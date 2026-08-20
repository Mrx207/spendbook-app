import { parseCSV, parseStatementRows, parseNumber, merchantFromNarration } from "../lib/statement.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

// --- number parsing ---
check("plain", parseNumber("450.00"), 450);
check("commas", parseNumber("1,23,456.78"), 123456.78);
check("dr suffix", parseNumber("1,234.56 Dr"), 1234.56);
check("parens negative", parseNumber("(1,234.56)"), -1234.56);
check("empty", parseNumber(""), null);
check("dash", parseNumber("-"), null);
check("text", parseNumber("N/A"), null);

// --- merchant extraction ---
check("upi narration", merchantFromNarration("UPI/DR/451234567890/SWIGGY/YESB/swiggy@ybl/Payment"), "swiggy");
check("neft", merchantFromNarration("NEFT/CITIN12345/ACME CONSULTING PVT"), "ACME CONSULTING PVT");
check("empty narration", merchantFromNarration(""), "Unknown");

// --- HDFC-style: separate debit/credit columns, junk preamble ---
const hdfc = `Account Statement
Account No: 501000123456
Period: 01/08/2026 to 20/08/2026

Date,Narration,Chq/Ref No,Withdrawal Amt.,Deposit Amt.,Closing Balance
20/08/26,UPI/DR/451234567890/SWIGGY/YESB/swiggy@ybl/Payment,451234567890,450.00,,42150.00
19/08/26,NEFT/CITIN12345/ACME CONSULTING PVT,CITIN12345,,85000.00,42600.00
18/08/26,ATM WDL/CASH/MUMBAI,000000,2000.00,,-
`;
const a = parseStatementRows(parseCSV(hdfc));
check("hdfc count", a.txns.length, 3);
check("hdfc debit", [a.txns[0].type, a.txns[0].amount, a.txns[0].date], ["debit", 450, "2026-08-20"]);
check("hdfc credit", [a.txns[1].type, a.txns[1].amount], ["credit", 85000]);
check("hdfc merchant", a.txns[0].merchant, "swiggy");
check("hdfc balance not treated as credit", a.txns[2].amount, 2000);

// --- single amount column + Dr/Cr indicator ---
const icici = `Value Date,Transaction Remarks,Amount,Dr/Cr,Balance
15-Aug-2026,POS/AMAZON RETAIL,1299.50,Dr,10000.00
14-Aug-2026,SALARY CREDIT,75000,Cr,11299.50
`;
const b = parseStatementRows(parseCSV(icici));
check("icici count", b.txns.length, 2);
check("icici dr", [b.txns[0].type, b.txns[0].amount, b.txns[0].date], ["debit", 1299.5, "2026-08-15"]);
check("icici cr", [b.txns[1].type, b.txns[1].amount], ["credit", 75000]);

// --- signed single amount, no indicator ---
const signed = `Date,Description,Amount
2026-08-10,Netflix subscription,-649
2026-08-09,Refund,1200
`;
const c = parseStatementRows(parseCSV(signed));
check("signed debit", [c.txns[0].type, c.txns[0].amount], ["debit", 649]);
check("signed credit", [c.txns[1].type, c.txns[1].amount], ["credit", 1200]);

// --- quoted fields with embedded commas ---
const quoted = `Date,Narration,Debit,Credit
2026-08-05,"PAYMENT TO ACME, INC",1500.00,
`;
const d = parseStatementRows(parseCSV(quoted));
check("quoted comma", [d.txns.length, d.txns[0].amount], [1, 1500]);

// --- garbage input ---
const junk = parseStatementRows(parseCSV("hello\nworld\n"));
check("no table", !!junk.error, true);

// --- rows with unparseable dates are skipped, not crashed on ---
const partial = `Date,Narration,Debit,Credit
2026-08-01,GOOD ROW,100,
Opening Balance,,,
,TOTALS,999,
`;
const e = parseStatementRows(parseCSV(partial));
check("skips junk rows", [e.txns.length, e.skipped], [1, 2]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
