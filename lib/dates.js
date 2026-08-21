// The Postgres driver returns DATE columns as Date objects, whose default
// string form is a locale stamp ("Thu Feb 05") - no year, and nothing that
// compares or sorts correctly. Anywhere a stored date meets one that came in
// as text, both have to be put in the same shape first.
export function toISODate(value) {
  if (!value) return "";
  if (value instanceof Date) {
    if (isNaN(value)) return "";
    // Local parts, not toISOString: the column holds a calendar day, and
    // converting to UTC can shift it either side of midnight.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).slice(0, 10);
}
