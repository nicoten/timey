/**
 * How the month is shown: as the calendar of shaded days, as a table of every
 * entry, or totalled per client. Remembered in localStorage like the theme.
 */

export type MonthMode = "calendar" | "entries" | "clients";

export const MONTH_MODES: { value: MonthMode; label: string }[] = [
  { value: "calendar", label: "Calendar" },
  { value: "entries", label: "Entries" },
  { value: "clients", label: "Clients" },
];

const STORAGE_KEY = "timey.monthMode";

function isMode(value: unknown): value is MonthMode {
  return value === "calendar" || value === "entries" || value === "clients";
}

/** Reading storage can throw outright in some contexts, so never let it escape. */
export function loadMonthMode(): MonthMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isMode(stored) ? stored : "calendar";
  } catch {
    return "calendar";
  }
}

export function saveMonthMode(mode: MonthMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // A remembered view is a convenience, not a requirement.
  }
}
