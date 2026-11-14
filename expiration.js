// Quote validity: a revision issued on Eastern calendar date D stays valid through 11:59 PM
// Eastern on D + 14 (that is, until 23:59:59.999), and is expired from the next instant on.
export const QUOTE_VALID_DAYS = 14;
const TIME_ZONE = 'America/New_York';

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function easternParts(ms) {
  const parts = Object.fromEntries(partsFormat.formatToParts(ms).map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute,
    second: parts.second };
}

// Eastern offset from UTC at the instant ms, in milliseconds (e.g. -4 h in summer, -5 h in winter).
function easternOffset(ms) {
  const p = easternParts(ms);
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecond;
}

// The UTC instant of an Eastern wall-clock time. Not used near the 2 AM daylight-saving switch.
function easternToUtc(year, month, day, hour, minute, second, millisecond) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const first = asIfUtc - easternOffset(asIfUtc);
  return asIfUtc - easternOffset(first);
}

// The expiration timestamp (ISO, UTC) for a revision issued at `issuedAt`.
export function expirationFor(issuedAt) {
  const { year, month, day } = easternParts(issuedAt.getTime());
  const last = new Date(Date.UTC(year, month - 1, day + QUOTE_VALID_DAYS));
  return new Date(easternToUtc(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate(), 23, 59, 59, 999))
    .toISOString();
}

// Revisions saved before expiration existed have no timestamp and never expire.
export function isExpired(expiresAt, now) {
  return expiresAt != null && now.getTime() > Date.parse(expiresAt);
}

const displayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit',
});

// E.g. "Wed, May 15, 2030, 11:59 PM Eastern".
export function formatEastern(iso) {
  return displayFormat.format(new Date(iso)) + ' Eastern';
}
