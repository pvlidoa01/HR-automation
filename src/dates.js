// Reading dates that people type.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Reads a date typed by a person. Day comes first (European): 06/01/2027 is 6 January 2027. Returns 'YYYY-MM-DD' or null. */
export function parseTypedDate(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let y; let m; let d;
  let match;
  if ((match = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [, y, m, d] = match;
  else if ((match = t.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/))) [, d, m, y] = match;
  else if ((match = t.match(/^(\d{1,2})[-/. ]([a-z]{3,9})[-/. ](\d{4})$/))) {
    [, d, , y] = match;
    m = MONTHS.indexOf(match[2].slice(0, 3)) + 1;
  } else return null;
  y = Number(y); m = Number(m); d = Number(d);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (!m || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
