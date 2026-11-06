/* When is an offer open? The same rule as the CultureBlocs AppView
 * (appview/app/places.py): status is 'open' and the time is inside any
 * validFrom/validUntil window. Any other status, known or not, is closed;
 * past validUntil an offer is closed whatever its status says. */

const when = (s) => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

export function offerIsOpen(value, now = new Date()) {
  if (!value || typeof value !== 'object' || value.status !== 'open') return false;
  const t = now.getTime();
  const from = when(value.validFrom), until = when(value.validUntil);
  if (from !== null && t < from) return false;
  if (until !== null && t >= until) return false;
  return true;
}
