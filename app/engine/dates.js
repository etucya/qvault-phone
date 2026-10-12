// Dates as the Mac writes and reads them. Swift's `.iso8601` strategy writes
// `2026-09-02T14:36:12Z` and refuses a date with fractional seconds, which would make the
// Mac call the whole file damaged — so everything written here is cut to whole seconds.

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** `"2026-09-02T14:36:12Z"`: UTC, whole seconds (truncated, never rounded up). */
export function isoSeconds(date) {
  const time = date instanceof Date ? date.getTime() : NaN;
  if (!Number.isFinite(time)) throw new TypeError(`Not a valid date: ${date}`);
  const whole = Math.floor(time / 1000) * 1000;
  return new Date(whole).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Reads an ISO-8601 date-time with a `Z` or an offset. Throws on anything else. */
export function parseISO(string) {
  const match = typeof string === 'string' ? ISO.exec(string) : null;
  if (!match) throw new TypeError(`Not an ISO-8601 date: ${string}`);
  const [, y, mo, d, h, mi, s] = match.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) {
    throw new TypeError(`Not an ISO-8601 date: ${string}`);
  }
  const date = new Date(string.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(date.getTime())) throw new TypeError(`Not an ISO-8601 date: ${string}`);
  return date;
}
