// Derived views over the ledger. Pure functions of the transaction list so the
// same logic can be tested directly and reused wherever it is needed.

const dayOf = (d) => String(d).slice(0, 10);
const monthOf = (d) => String(d).slice(0, 7);
const num = (v) => Number(v) || 0;

export const monthsBetween = (a, b) => {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
};

/**
 * Totals for an arbitrary set of transactions - what a search result adds up
 * to, how often it happens, and what it costs in a typical month.
 */
export function summarise(list) {
  if (!list.length) return null;
  const total = list.reduce((s, t) => s + num(t.amount), 0);
  const days = list.map(t => dayOf(t.date)).sort();
  const first = days[0];
  const last = days[days.length - 1];

  const perMonth = {};
  list.forEach(t => { perMonth[monthOf(t.date)] = (perMonth[monthOf(t.date)] || 0) + num(t.amount); });
  const months = Object.keys(perMonth).sort();

  // Span rather than count of active months: a subscription skipped in March
  // still costs you its share of the year.
  const span = months.length ? monthsBetween(months[0], months[months.length - 1]) + 1 : 1;
  const biggest = list.reduce((a, b) => (num(a.amount) >= num(b.amount) ? a : b));

  return {
    count: list.length,
    total,
    average: total / list.length,
    perMonthAverage: total / span,
    first, last, span,
    biggest: { amount: num(biggest.amount), merchant: biggest.merchant, date: dayOf(biggest.date) },
    months: months.map(m => ({ month: m, total: perMonth[m] })),
  };
}

/**
 * Compares a month against the one before it, per category and overall, so a
 * total has something to be measured against.
 */
export function compareMonths(txns, catMap, month) {
  const prev = (() => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();

  const spend = (ym) => txns.filter(t =>
    monthOf(t.date) === ym && (catMap[t.category_id]?.kind || "expense") === "expense");

  const now = spend(month);
  const before = spend(prev);
  const sum = (l) => l.reduce((s, t) => s + num(t.amount), 0);

  const byCat = (list) => {
    const m = {};
    list.forEach(t => { m[t.category_id] = (m[t.category_id] || 0) + num(t.amount); });
    return m;
  };
  const a = byCat(now), b = byCat(before);

  const moves = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .map(id => ({ id, now: a[id] || 0, before: b[id] || 0, delta: (a[id] || 0) - (b[id] || 0) }))
    .filter(x => Math.abs(x.delta) > 1)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  return {
    prev, hasPrev: before.length > 0,
    total: sum(now), prevTotal: sum(before),
    delta: sum(now) - sum(before),
    moves,
  };
}

/**
 * Finds charges that repeat on a roughly monthly cycle - subscriptions, rent,
 * EMIs. Flags ones that have gone quiet, which is usually where money leaks:
 * a service still billing, or one you meant to cancel and did not.
 */
export function findRecurring(txns, catMap, today = new Date()) {
  const groups = {};
  txns
    .filter(t => (catMap[t.category_id]?.kind || "expense") === "expense")
    .forEach(t => {
      const key = (t.merchant || "").trim().toLowerCase();
      if (!key || key === "unknown") return;
      (groups[key] = groups[key] || []).push(t);
    });

  const out = [];
  for (const [key, list] of Object.entries(groups)) {
    if (list.length < 3) continue;

    const sorted = [...list].sort((a, b) => dayOf(a.date) < dayOf(b.date) ? -1 : 1);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((new Date(dayOf(sorted[i].date)) - new Date(dayOf(sorted[i-1].date))) / 86400000);
    }
    const monthly = gaps.filter(g => g >= 25 && g <= 36).length;
    // Most of the gaps must look monthly, so a merchant visited at random
    // intervals doesn't get mistaken for a subscription.
    if (monthly < Math.max(2, Math.ceil(gaps.length * 0.6))) continue;

    const amounts = sorted.map(t => num(t.amount));
    const avg = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    // A steady charge, not a shop you happen to visit monthly for varying sums.
    const steady = amounts.every(v => Math.abs(v - avg) <= Math.max(avg * 0.2, 25));
    if (!steady) continue;

    const last = dayOf(sorted[sorted.length - 1].date);
    const sinceLast = Math.round((today - new Date(last)) / 86400000);

    out.push({
      merchant: sorted[sorted.length - 1].merchant,
      key,
      category_id: sorted[sorted.length - 1].category_id,
      count: sorted.length,
      amount: Math.round(avg * 100) / 100,
      yearly: Math.round(avg * 12),
      last,
      sinceLast,
      // Two cycles missed means it either stopped or is about to surprise you.
      dormant: sinceLast > 70,
      due: sinceLast >= 25 && sinceLast <= 70,
    });
  }
  return out.sort((a, b) => b.yearly - a.yearly);
}

/**
 * The merchants clogging up Uncategorised, worst first, so the backlog can be
 * cleared in the order that buys the most clarity per decision.
 */
export function backlog(txns, unsorted = ["other"]) {
  const groups = {};
  txns.filter(t => unsorted.includes(t.category_id)).forEach(t => {
    const key = (t.merchant || "Unknown").trim();
    (groups[key] = groups[key] || []).push(t);
  });

  return Object.entries(groups)
    .map(([merchant, list]) => ({
      merchant,
      ids: list.map(t => t.id),
      count: list.length,
      total: list.reduce((s, t) => s + num(t.amount), 0),
      sample: list.find(t => t.raw)?.raw || "",
      lastDate: list.map(t => dayOf(t.date)).sort().pop(),
    }))
    .sort((a, b) => b.total - a.total);
}
