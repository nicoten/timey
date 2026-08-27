/**
 * Money is integer cents everywhere. Nothing here produces a float that later
 * gets added to another float.
 */

const CURRENCY = "USD";
const LOCALE = "en-US";

const formatter = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(cents: number): string {
  return formatter.format(cents / 100);
}

const compactFormatter = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  maximumFractionDigits: 0,
});

/** For dense places like a calendar cell, where cents are noise. */
export function formatMoneyCompact(cents: number): string {
  return compactFormatter.format(cents / 100);
}

/**
 * What one entry earned, rounded to the cent. Returns `null` when the project
 * has no rate — that is "not billable", which is different from zero.
 *
 * Totals sum these rounded per-entry amounts rather than rounding a running
 * exact total, so the rows on screen always add up to the total shown.
 */
export function earnedCents(hourlyRateCents: number | null, minutes: number): number | null {
  if (hourlyRateCents === null) return null;
  return Math.round((hourlyRateCents * minutes) / 60);
}

export function sumEarnedCents(
  entries: { hourlyRateCents: number | null; durationMinutes: number }[],
): number {
  return entries.reduce(
    (total, entry) => total + (earnedCents(entry.hourlyRateCents, entry.durationMinutes) ?? 0),
    0,
  );
}

/** `"150"` -> `15000`, `"150.5"` -> `15050`, `""` -> `null`. */
export function parseRateToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error("Enter a rate like 150 or 150.50.");
  }
  return Math.round(Number(trimmed) * 100);
}

/** `15000` -> `"150.00"`, for populating an edit field. */
export function centsToRateInput(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

/** `90` -> `"1h 30m"`. */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}
