import { reconcile } from "../lib/insights.js";
import { extractBalance, parseSMS } from "../lib/parser.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

// --- balance extraction ---
check("idfc available balance",
  extractBalance("Your A/c XX2879 debited by Rs. 5,000.00 on 21/08/26; X credited. RRN 1. Available balance Rs. 2,90,937.67."),
  290937.67);
check("avl bal short form", extractBalance("Rs.450 debited. Avl Bal Rs 12,345.60"), 12345.6);
check("a/c bal", extractBalance("txn done. A/c Bal: INR 987.00"), 987);
check("clos balance", extractBalance("Closing Balance 1,00,000"), 100000);
check("no balance mentioned", extractBalance("Rs.450.00 debited from a/c XX1234 to VPA swiggy@ybl"), null);
// The transaction amount must not be mistaken for a balance.
check("amount alone is not a balance", extractBalance("Rs. 5,000.00 debited"), null);
check("balance reaches parseSMS",
  parseSMS("Your A/c XX2879 debited by Rs. 5,000.00 on 21/08/26. Available balance Rs. 2,90,937.67.").balance,
  290937.67);

// --- reconciliation ---
const t = (date, amount, type, balance, extra={}) =>
  ({ id: date+amount, date, amount, type, balance, account_id: "a1", merchant: "M"+amount, ...extra });

// A complete run: each balance follows from the one before.
const clean = [
  t("2026-08-01", 100, "debit", 900),
  t("2026-08-02", 200, "debit", 700),
  t("2026-08-03", 500, "credit", 1200),
];
const okRes = reconcile(clean);
check("clean ledger has no gaps", okRes.count, 0);
check("clean ledger was checkable", [okRes.checked, okRes.verifiable], [2, true]);

// A missing debit of 300 between rows two and three.
const missing = [
  t("2026-08-01", 100, "debit", 900),
  t("2026-08-02", 200, "debit", 700),
  t("2026-08-04", 50, "debit", 350),   // expects 650, actually 350
];
const gap = reconcile(missing);
check("gap found", gap.count, 1);
check("gap amount", gap.gaps[0].missing, 300);
check("gap direction is money out", gap.gaps[0].direction, "debit");
// The gap must name the two ledger rows it sits between, in full - a date
// range and a compacted balance give nothing to search a bank's SMS thread
// for. This is the detail the investigation actually depends on.
check("gap names the surrounding rows",
  [gap.gaps[0].before.date, gap.gaps[0].before.merchant, gap.gaps[0].before.balance,
   gap.gaps[0].after.date, gap.gaps[0].after.merchant, gap.gaps[0].after.balance],
  ["2026-08-02", "M200", 700, "2026-08-04", "M50", 350]);
check("gap total", gap.total, 300);

// Unrecorded money arriving reads as a credit gap.
const inflow = [t("2026-08-01", 100, "debit", 900), t("2026-08-02", 100, "debit", 1300)];
check("unrecorded credit", reconcile(inflow).gaps[0].direction, "credit");
check("unrecorded credit amount", reconcile(inflow).gaps[0].missing, 500);

// Two accounts interleaved have unrelated balances and must not cross-check.
const twoAccounts = [
  { id:"x1", date:"2026-08-01", amount:100, type:"debit", balance:900, account_id:"a1" },
  { id:"y1", date:"2026-08-01", amount:50,  type:"debit", balance:5000, account_id:"a2" },
  { id:"x2", date:"2026-08-02", amount:100, type:"debit", balance:800, account_id:"a1" },
  { id:"y2", date:"2026-08-02", amount:50,  type:"debit", balance:4950, account_id:"a2" },
];
check("accounts checked separately", reconcile(twoAccounts).count, 0);

// Rows without a balance cannot be checked, and that is reported honestly
// rather than passing as clean.
const noBalance = [
  { id:"n1", date:"2026-08-01", amount:100, type:"debit", balance:null },
  { id:"n2", date:"2026-08-02", amount:100, type:"debit", balance:null },
];
const none = reconcile(noBalance);
check("nothing to check", [none.checked, none.count], [0, 0]);
check("reports as unverifiable", none.verifiable, false);

// Rounding noise must not be reported as a gap.
const rounding = [t("2026-08-01", 100, "debit", 900.0), t("2026-08-02", 100, "debit", 799.6)];
check("small drift tolerated", reconcile(rounding).count, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
