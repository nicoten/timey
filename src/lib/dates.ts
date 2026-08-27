/**
 * Calendar arithmetic for the month view.
 *
 * Dates are handled as `YYYY-MM-DD` strings throughout, matching the wall-clock
 * format the database stores. `Date` is used only to ask the calendar which
 * weekday a date falls on, and always via the local-time constructor —
 * `new Date("2026-08-01")` parses as UTC and can land on the previous day.
 */

export interface MonthCursor {
  year: number;
  /** 1-12, not the 0-11 that `Date` uses. */
  month: number;
}

/** Weeks start on Monday. */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function todayIso(): string {
  const now = new Date();
  return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function currentMonth(): MonthCursor {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function shiftMonth(cursor: MonthCursor, delta: number): MonthCursor {
  const zeroBased = cursor.month - 1 + delta;
  return {
    year: cursor.year + Math.floor(zeroBased / 12),
    month: ((zeroBased % 12) + 12) % 12 + 1,
  };
}

export function isSameMonth(a: MonthCursor, b: MonthCursor): boolean {
  return a.year === b.year && a.month === b.month;
}

/** `"August 2026"`. */
export function monthLabel(cursor: MonthCursor): string {
  return `${MONTH_NAMES[cursor.month - 1]} ${cursor.year}`;
}

export function daysInMonth(cursor: MonthCursor): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(cursor.year, cursor.month, 0).getDate();
}

/** Inclusive lower bound for a month query. */
export function monthStart(cursor: MonthCursor): string {
  return isoDate(cursor.year, cursor.month, 1);
}

/** Exclusive upper bound for a month query. */
export function monthEndExclusive(cursor: MonthCursor): string {
  return monthStart(shiftMonth(cursor, 1));
}

/** 0 for Monday through 6 for Sunday. */
export function weekdayIndex(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return (new Date(year, month - 1, day).getDay() + 6) % 7;
}

export function isWeekend(date: string): boolean {
  return weekdayIndex(date) >= 5;
}

/**
 * The month laid out in whole weeks. `null` marks a leading or trailing cell
 * belonging to an adjacent month, so the grid stays rectangular.
 */
export function monthGrid(cursor: MonthCursor): (string | null)[] {
  const total = daysInMonth(cursor);
  const leading = weekdayIndex(monthStart(cursor));

  const cells: (string | null)[] = Array(leading).fill(null);
  for (let day = 1; day <= total; day += 1) {
    cells.push(isoDate(cursor.year, cursor.month, day));
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  return cells;
}

/** `"Thursday, 27 August"`. */
export function dayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "long",
  });
  return `${weekday}, ${day} ${MONTH_NAMES[month - 1]}`;
}

export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

/** `"2026-08-27T09:15"` -> `"09:15"`. */
export function timeOfDay(startedAt: string): string {
  return startedAt.slice(11, 16);
}

/** `"2026-08-27"` + `"09:15"` -> `"2026-08-27T09:15"`. */
export function combineDateAndTime(date: string, time: string): string {
  return `${date}T${time}`;
}

/**
 * Where an entry ends, as a time of day. Returns `null` when it runs past
 * midnight, since that no longer belongs to the day being displayed.
 */
export function endTimeOfDay(startedAt: string, durationMinutes: number): string | null {
  const [hours, minutes] = timeOfDay(startedAt).split(":").map(Number);
  const total = hours * 60 + minutes + durationMinutes;
  if (total >= 24 * 60) return null;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

