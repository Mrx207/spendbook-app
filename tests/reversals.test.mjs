import { findReversals } from "../lib/insights.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const t = (id, date, amount, type, extra={}) =>
  ({ id, date, amount, type, merchant: id, last4: "2879", kind: type === "credit" ? "income" : "expense", ...extra });

// The case that prompted this: 722 out to a payee, 722 back the same day.
const failed = [
  t("out", "2026-08-23", 722, "debit"),
  t("back", "2026-08-23", 722, "credit"),
];
const r = findReversals(failed);
check("pair found", r.count, 1);
check("amount", r.total, 722);
check("same day", r.pairs[0].days, 0);
check("both sides identified", [r.pairs[0].debit.id, r.pairs[0].credit.id], ["out", "back"]);

// A credit before its debit is not a reversal of it.
check("credit first is not a reversal",
  findReversals([t("c","2026-08-01",500,"credit"), t("d","2026-08-05",500,"debit")]).count, 0);

// Too far apart to be one payment failing.
check("outside the window",
  findReversals([t("d","2026-08-01",500,"debit"), t("c","2026-08-20",500,"credit")]).count, 0);

// Different amounts never pair.
check("amounts must match",
  findReversals([t("d","2026-08-01",500,"debit"), t("c","2026-08-02",501,"credit")]).count, 0);

// Different accounts never pair.
check("accounts must match",
  findReversals([t("d","2026-08-01",500,"debit",{last4:"1111"}), t("c","2026-08-02",500,"credit",{last4:"2222"})]).count, 0);

// One credit cannot settle two debits.
const twoOut = [
  t("d1","2026-08-01",300,"debit"), t("d2","2026-08-02",300,"debit"),
  t("c1","2026-08-03",300,"credit"),
];
check("one credit takes one debit", findReversals(twoOut).count, 1);
check("nearest debit chosen", findReversals(twoOut).pairs[0].debit.id, "d2");

// Two genuine failures on the same day pair up one to one.
const twoPairs = [
  t("a1","2026-08-01",100,"debit"), t("a2","2026-08-01",100,"credit"),
  t("b1","2026-08-01",100,"debit"), t("b2","2026-08-01",100,"credit"),
];
check("two pairs", findReversals(twoPairs).count, 2);

// Already filed as transfers on both sides, so nothing left to suggest.
const done = [
  t("out","2026-08-23",722,"debit",{kind:"transfer"}),
  t("back","2026-08-23",722,"credit",{kind:"transfer"}),
];
check("settled pairs are not re-suggested", findReversals(done).count, 0);

// Biggest first, since that is what distorts the totals most.
const mixed = [
  t("s1","2026-08-01",50,"debit"), t("s2","2026-08-01",50,"credit"),
  t("l1","2026-08-02",5000,"debit"), t("l2","2026-08-02",5000,"credit"),
];
check("largest first", findReversals(mixed).pairs.map(p=>p.amount), [5000, 50]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
