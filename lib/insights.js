// Derived views over the ledger. Pure functions of the transaction list so the
// same logic can be tested directly and reused wherever it is needed.

const dayOf = (d) => String(d).slice(0, 10);
const monthOf = (d) => String(d).slice(0, 7);
const num = (v) => Number(v) || 0;

// --- periods -------------------------------------------------------------
// All period maths runs on YYYY-MM-DD strings through UTC, never on local
// Date parts: a ledger day is a calendar day the bank recorded, and building
// local Dates would shift it across midnight either side of the timezone.

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const utc = (day) => new Date(`${String(day).slice(0,10)}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => { const d = utc(day); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

export const today = () => iso(new Date());

// Weeks start on Monday, which is how a spending week is usually thought of.
export function startOfWeek(day) {
  const d = utc(day);
  const shift = (d.getUTCDay() + 6) % 7; // Sunday is 0, so pull it back six
  d.setUTCDate(d.getUTCDate() - shift);
  return iso(d);
}

/** The bounds and label of the period containing `anchor`. */
export function periodRange(period, anchor) {
  const day = String(anchor).slice(0, 10);
  if (period === "week") {
    const start = startOfWeek(day);
    const end = addDays(start, 6);
    const [, sm, sd] = start.split("-");
    const [ey, em, ed] = end.split("-");
    const label = sm === em
      ? `${+sd}–${+ed} ${MONTH_NAMES[+em - 1]}`
      : `${+sd} ${MONTH_NAMES[+sm - 1]} – ${+ed} ${MONTH_NAMES[+em - 1]}`;
    return { start, end, label: `${label} ${ey}`, key: start };
  }
  if (period === "year") {
    const y = day.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: y, key: y };
  }
  const ym = day.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2,"0")}`,
           label: `${MONTH_NAMES[m - 1]} ${y}`, key: ym };
}

/** Moves `anchor` by whole periods, staying inside the month for month steps. */
export function shiftPeriod(period, anchor, by) {
  const day = String(anchor).slice(0, 10);
  if (period === "week") return addDays(startOfWeek(day), by * 7);
  if (period === "year") return `${Number(day.slice(0,4)) + by}-01-01`;
  const [y, m] = day.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return iso(d);
}

/** Totals for the last `count` periods ending at `anchor`, oldest first. */
export function periodBuckets(txns, catMap, period, anchor, count = 12) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const at = shiftPeriod(period, anchor, -i);
    const { start, end, label, key } = periodRange(period, at);
    const total = txns
      .filter(t => {
        const d = String(t.date).slice(0, 10);
        return d >= start && d <= end && (catMap[t.category_id]?.kind || "expense") === "expense";
      })
      .reduce((s, t) => s + num(t.amount), 0);
    out.push({ key, label, total, start, end });
  }
  return out;
}

/** Compares the period at `anchor` against the one before it, overall and by category. */
export function comparePeriods(txns, catMap, period, anchor) {
  const now = periodRange(period, anchor);
  const prev = periodRange(period, shiftPeriod(period, anchor, -1));

  const within = (r) => txns.filter(t => {
    const d = String(t.date).slice(0, 10);
    return d >= r.start && d <= r.end && (catMap[t.category_id]?.kind || "expense") === "expense";
  });

  const a = within(now), b = within(prev);
  const sum = (l) => l.reduce((s, t) => s + num(t.amount), 0);
  const byCat = (list) => {
    const m = {};
    list.forEach(t => { m[t.category_id] = (m[t.category_id] || 0) + num(t.amount); });
    return m;
  };
  const ca = byCat(a), cb = byCat(b);

  return {
    label: now.label, prevLabel: prev.label,
    hasPrev: b.length > 0,
    total: sum(a), prevTotal: sum(b), delta: sum(a) - sum(b),
    moves: [...new Set([...Object.keys(ca), ...Object.keys(cb)])]
      .map(id => ({ id, now: ca[id] || 0, before: cb[id] || 0, delta: (ca[id] || 0) - (cb[id] || 0) }))
      .filter(x => Math.abs(x.delta) > 1)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)),
  };
}

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
 * Finds payments that went out and came straight back - a failed UPI transfer,
 * a declined card charge, a cancelled order.
 *
 * Left alone these count twice over: once as money spent and again as money
 * earned, when nothing actually happened. Matching is deliberately strict -
 * same account, same amount to the paisa, credit not before the debit, within
 * a few days - and the result is offered as a suggestion rather than applied,
 * because a friend repaying the exact sum you sent them looks identical from
 * here and is not the same thing at all.
 */
export function findReversals(txns, windowDays = 5) {
  const accountOf = (t) => t.account_id || t.last4 || "default";
  const dayNum = (d) => Math.floor(new Date(`${String(d).slice(0,10)}T00:00:00Z`) / 86400000);

  const debits = txns
    .filter(t => t.type === "debit")
    .map(t => ({ t, day: dayNum(t.date), amount: num(t.amount), used: false }))
    .sort((a, b) => a.day - b.day);

  const credits = txns
    .filter(t => t.type === "credit")
    .map(t => ({ t, day: dayNum(t.date), amount: num(t.amount) }))
    .sort((a, b) => a.day - b.day);

  const pairs = [];
  for (const c of credits) {
    // Nearest eligible debit first, so a run of equal amounts pairs up in order
    // rather than the credit claiming the oldest one.
    const hit = debits
      .filter(d => !d.used
        && Math.abs(d.amount - c.amount) < 0.01
        && accountOf(d.t) === accountOf(c.t)
        && d.day <= c.day
        && c.day - d.day <= windowDays)
      .sort((a, b) => (c.day - a.day) - (c.day - b.day))[0];
    if (!hit) continue;
    hit.used = true;
    pairs.push({
      amount: c.amount,
      days: c.day - hit.day,
      debit: { id: hit.t.id, date: String(hit.t.date).slice(0,10), merchant: hit.t.merchant, category_id: hit.t.category_id },
      credit: { id: c.t.id, date: String(c.t.date).slice(0,10), merchant: c.t.merchant, category_id: c.t.category_id },
      // Once both sides are transfers there is nothing left to suggest.
      settled: hit.t.kind === "transfer" && c.t.kind === "transfer",
    });
  }

  const open = pairs.filter(p => !p.settled);
  return {
    pairs: open.sort((a, b) => b.amount - a.amount),
    count: open.length,
    total: Math.round(open.reduce((s, p) => s + p.amount, 0) * 100) / 100,
  };
}

/**
 * Checks the ledger against the balances the bank reported.
 *
 * Every alert and statement row states the balance afterwards. Between two
 * consecutive rows the balance should move by exactly the second row's amount;
 * if it moved further, transactions in between are missing from the ledger.
 * This is what makes completeness answerable without comparing anything by
 * hand - the bank's own figures do the checking.
 *
 * Rows are grouped by account, since two accounts interleaved have unrelated
 * balances, and only runs that actually report a balance can be checked.
 */
export function reconcile(txns, tolerance = 1) {
  const byAccount = {};
  txns
    .filter(t => t.balance !== null && t.balance !== undefined && t.balance !== "")
    .forEach(t => {
      const key = t.account_id || t.last4 || "default";
      (byAccount[key] = byAccount[key] || []).push(t);
    });

  const gaps = [];
  let checked = 0;

  for (const [account, list] of Object.entries(byAccount)) {
    // Oldest first, and within a day keep the order the balance implies rather
    // than insertion order, which a statement import does not preserve.
    const sorted = [...list].sort((a, b) => {
      const da = String(a.date).slice(0,10), db = String(b.date).slice(0,10);
      if (da !== db) return da < db ? -1 : 1;
      return num(a.balance) - num(b.balance);
    });

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i-1], cur = sorted[i];
      const signed = cur.type === "credit" ? num(cur.amount) : -num(cur.amount);
      const expected = num(prev.balance) + signed;
      const drift = num(cur.balance) - expected;
      checked++;
      if (Math.abs(drift) <= tolerance) continue;

      gaps.push({
        account,
        // Positive drift means money arrived that was never recorded.
        missing: Math.round(Math.abs(drift) * 100) / 100,
        direction: drift > 0 ? "credit" : "debit",
        // The two ledger rows the gap sits between, in full - a date range and
        // a rounded balance give nothing to search an SMS thread for. The
        // exact balance either side, and what the ledger already knows
        // happened right before and after, is what turns this into something
        // that can actually be tracked down.
        before: { id: prev.id, date: String(prev.date).slice(0,10), time: prev.time || "",
                   merchant: prev.merchant, amount: num(prev.amount), type: prev.type,
                   balance: num(prev.balance) },
        after: { id: cur.id, date: String(cur.date).slice(0,10), time: cur.time || "",
                  merchant: cur.merchant, amount: num(cur.amount), type: cur.type,
                  balance: num(cur.balance) },
      });
    }
  }

  const total = gaps.reduce((s, g) => s + g.missing, 0);
  return {
    checked,
    gaps: gaps.sort((a, b) => b.missing - a.missing),
    count: gaps.length,
    total: Math.round(total * 100) / 100,
    // Nothing to check is not the same as everything being fine.
    verifiable: checked > 0,
  };
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
