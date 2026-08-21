import { toISODate } from "../lib/dates.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
};

// The bug this exists to prevent: a Date stringifies to a locale stamp with no
// year, so a stored date never matched one that arrived as text and duplicate
// detection silently passed everything through.
check("Date object", toISODate(new Date(2026, 1, 5)), "2026-02-05");
check("not a locale stamp", toISODate(new Date(2026, 1, 5)).startsWith("Thu"), false);
check("pads single digits", toISODate(new Date(2026, 0, 9)), "2026-01-09");
check("ISO string passes through", toISODate("2026-08-20"), "2026-08-20");
check("timestamp string is trimmed", toISODate("2026-08-20T00:00:00.000Z"), "2026-08-20");
check("empty", toISODate(null), "");
check("invalid date", toISODate(new Date("nonsense")), "");

// A stored Date and an incoming string for the same day must agree, which is
// the whole point - this is the comparison duplicate detection relies on.
check("stored and incoming agree",
  toISODate(new Date(2026, 7, 20)) === toISODate("2026-08-20"), true);

// Late-evening dates must not roll back a day through a UTC conversion.
check("no timezone shift", toISODate(new Date(2026, 7, 20, 23, 45)), "2026-08-20");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
