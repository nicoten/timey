/**
 * Money is integer cents everywhere. Nothing here produces a float that later
 * gets added to another float.
 *
 * Each client is billed in one currency, so amounts for different clients may
 * be in different currencies and are never added together.
 */

/** Matches `CURRENCIES` in `src-tauri/src/validate.rs`. */
export const CURRENCIES = ["USD", "EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = "USD";

const LOCALE = "en-US";

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let formatter = formatters.get(currency);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    formatters.set(currency, formatter);
  }
  return formatter;
}

export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY): string {
  return formatterFor(currency).format(cents / 100);
}

/** Cents per currency, in the order each currency was first seen. */
export type MoneyTotals = Map<string, number>;

/**
 * `"$2,000.00 · €500.00"`. Empty totals read as zero in the default currency,
 * matching how a month with nothing logged has always looked.
 */
export function formatMoneyTotals(totals: MoneyTotals): string {
  if (totals.size === 0) return formatMoney(0);
  return [...totals].map(([currency, cents]) => formatMoney(cents, currency)).join(" · ");
}

export function isZeroTotals(totals: MoneyTotals): boolean {
  return [...totals.values()].every((cents) => cents === 0);
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

interface Earning {
  hourlyRateCents: number | null;
  durationMinutes: number;
  amountCents: number | null;
  currency: string;
}

/** What one entry earned: its fixed price, or its time at the project's rate. */
export function entryEarnedCents(entry: Earning): number | null {
  return entry.amountCents ?? earnedCents(entry.hourlyRateCents, entry.durationMinutes);
}

/** What the entries earned, kept apart by currency. */
export function sumEarned(entries: Earning[]): MoneyTotals {
  const totals: MoneyTotals = new Map();
  for (const entry of entries) {
    const cents = entryEarnedCents(entry);
    if (cents === null) continue;
    totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + cents);
  }
  return totals;
}

/** `"150"` -> `15000`, `"150.5"` -> `15050`, `""` -> `null`. */
export function parseRateToCents(input: string): number | null {
  return parseCents(input, "Enter a rate like 150 or 150.50.");
}

/** As `parseRateToCents`, for a fixed price, which cannot be left blank. */
export function parseAmountToCents(input: string): number {
  const cents = parseCents(input, "Enter an amount like 500 or 500.50.");
  if (cents === null) throw new Error("Enter an amount.");
  return cents;
}

function parseCents(input: string, hint: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(hint);
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
