import { summarise, compareMonths, findRecurring, backlog, monthsBetween } from "../lib/insights.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

const catMap = {
  food: { kind: "expense" }, subs: { kind: "expense" }, rent: { kind: "expense" },
  income: { kind: "income" }, transfer: { kind: "transfer" }, other: { kind: "expense" },
};
const t = (date, amount, merchant, category_id = "food", extra = {}) =>
  ({ id: date + merchant + amount, date, amount, merchant, category_id, ...extra });

// --- summarise ---
const set = [t("2026-06-10", 100, "A"), t("2026-07-10", 300, "A"), t("2026-08-10", 200, "A")];
const s = summarise(set);
check("count", s.count, 3);
check("total", s.total, 600);
check("average", s.average, 200);
check("span covers gap months", s.span, 3);
check("per month", s.perMonthAverage, 200);
check("first/last", [s.first, s.last], ["2026-06-10", "2026-08-10"]);
check("biggest", [s.biggest.amount, s.biggest.date], [300, "2026-07-10"]);
check("month buckets", s.months.map(m=>m.total), [100, 300, 200]);
check("empty is null", summarise([]), null);

// A skipped month still counts towards the monthly average.
const gapped = [t("2026-01-05", 100, "B"), t("2026-03-05", 100, "B")];
check("gap month counted in span", summarise(gapped).span, 3);
check("months between", monthsBetween("2026-01", "2026-03"), 2);

// --- compareMonths ---
const two = [
  t("2026-07-01", 1000, "X", "food"), t("2026-07-02", 500, "Y", "rent"),
  t("2026-08-01", 1400, "X", "food"),
  t("2026-08-03", 9000, "Z", "income"),      // must not count as spend
  t("2026-08-04", 5000, "W", "transfer"),    // must not count as spend
];
const cmp = compareMonths(two, catMap, "2026-08");
check("current month spend only", cmp.total, 1400);
check("previous month spend", cmp.prevTotal, 1500);
check("delta", cmp.delta, -100);
check("prev month id", cmp.prev, "2026-07");
// Ranked by size of the move regardless of direction: rent vanishing (-500)
// is a bigger story than food rising (+400).
check("biggest mover first", [cmp.moves[0].id, cmp.moves[0].delta], ["rent", -500]);
check("food rise second", [cmp.moves[1].id, cmp.moves[1].delta], ["food", 400]);

// --- findRecurring ---
const netflix = ["2026-05-03","2026-06-03","2026-07-03","2026-08-03"].map(d => t(d, 649, "Netflix", "subs"));
const groceries = ["2026-08-01","2026-08-06","2026-08-13","2026-08-21"].map((d,i) => t(d, 300 + i*250, "BigBasket"));
const cancelled = ["2026-02-08","2026-03-08","2026-04-08"].map(d => t(d, 1199, "OldGym", "subs"));
const rec = findRecurring([...netflix, ...groceries, ...cancelled], catMap, new Date("2026-08-21"));

check("only steady monthly charges", rec.map(r=>r.merchant).sort(), ["Netflix","OldGym"]);
const nf = rec.find(r=>r.merchant==="Netflix");
check("netflix amount", nf.amount, 649);
check("netflix yearly", nf.yearly, 7788);
check("netflix not dormant", nf.dormant, false);
const gym = rec.find(r=>r.merchant==="OldGym");
check("stopped charge flagged dormant", gym.dormant, true);
check("sorted by yearly cost", rec[0].yearly >= rec[1].yearly, true);

// Varying amounts at monthly intervals are not a subscription.
const varying = ["2026-05-02","2026-06-02","2026-07-02"].map((d,i) => t(d, 500 + i*400, "Shop"));
check("varying amounts rejected", findRecurring(varying, catMap, new Date("2026-08-21")).length, 0);

// --- backlog ---
const messy = [
  t("2026-07-01", 100, "Priyanka", "other"), t("2026-07-05", 200, "Priyanka", "other"),
  t("2026-07-02", 5000, "One Mobi", "other", { raw: "UPI/DR/1/ONE MOBI" }),
  t("2026-07-03", 50, "Swiggy", "food"),
];
const b = backlog(messy);
check("only unsorted rows", b.length, 2);
check("worst by value first", b[0].merchant, "One Mobi");
check("groups ids", b.find(x=>x.merchant==="Priyanka").ids.length, 2);
check("keeps a sample of bank text", b[0].sample, "UPI/DR/1/ONE MOBI");


// --- periods -------------------------------------------------------------
import { periodRange, shiftPeriod, periodBuckets, comparePeriods, startOfWeek } from "../lib/insights.js";

// Weeks run Monday to Sunday.
check("monday stays", startOfWeek("2026-08-17"), "2026-08-17");
check("sunday pulls back six", startOfWeek("2026-08-23"), "2026-08-17");
check("saturday pulls back", startOfWeek("2026-08-22"), "2026-08-17");

const wk = periodRange("week", "2026-08-21");
check("week bounds", [wk.start, wk.end], ["2026-08-17", "2026-08-23"]);
check("week label", wk.label, "17\u201323 Aug 2026");

// A week spanning a month boundary names both months.
check("week across months", periodRange("week", "2026-09-01").label, "31 Aug \u2013 6 Sep 2026");

const mo = periodRange("month", "2026-02-14");
check("february ends on the 28th in 2026", [mo.start, mo.end], ["2026-02-01", "2026-02-28"]);
check("leap february", periodRange("month", "2024-02-14").end, "2024-02-29");
check("month label", mo.label, "Feb 2026");
check("year bounds", [periodRange("year","2026-05-05").start, periodRange("year","2026-05-05").end],
  ["2026-01-01", "2026-12-31"]);

// Stepping never lands mid-period or skips one.
check("week back", periodRange("week", shiftPeriod("week","2026-08-21",-1)).start, "2026-08-10");
check("month back over a year edge", shiftPeriod("month","2026-01-15",-1).slice(0,7), "2025-12");
check("month forward", shiftPeriod("month","2026-12-15",1).slice(0,7), "2027-01");
check("year back", shiftPeriod("year","2026-05-05",-1).slice(0,4), "2025");

// Buckets come back oldest first and only count spending.
const spread = [
  t("2026-08-18", 100, "A"), t("2026-08-20", 50, "A"),   // week of 17 Aug
  t("2026-08-11", 200, "B"),                              // week of 10 Aug
  t("2026-08-19", 9999, "C", "income"),                   // ignored
];
const wb = periodBuckets(spread, catMap, "week", "2026-08-21", 3);
check("three buckets oldest first", wb.map(b=>b.total), [0, 200, 150]);
check("bucket keys are week starts", wb.map(b=>b.key), ["2026-08-03","2026-08-10","2026-08-17"]);

const cp = comparePeriods(spread, catMap, "week", "2026-08-21");
check("week compare totals", [cp.total, cp.prevTotal, cp.delta], [150, 200, -50]);
check("week compare labels", cp.hasPrev, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
