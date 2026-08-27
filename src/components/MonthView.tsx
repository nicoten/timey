import { useMemo } from "react";

import type { EntryDetail } from "../lib/api";
import {
  WEEKDAY_LABELS,
  dayOfMonth,
  isSameMonth,
  isWeekend,
  currentMonth,
  monthGrid,
  monthLabel,
  shiftMonth,
  todayIso,
  type MonthCursor,
} from "../lib/dates";
import { formatMinutes, formatMoney, formatMoneyCompact, sumEarnedCents } from "../lib/money";
import { Button } from "./ui";

/** A full working day: the band reaches its tallest at this many minutes. */
const FULL_DAY_MINUTES = 8 * 60;
/** Percentage of cell height the band occupies at a full day, and at the minimum. */
const BAND_MAX_PERCENT = 28;
const BAND_MIN_PERCENT = 5;

interface DayTotal {
  minutes: number;
  cents: number;
}

interface Props {
  cursor: MonthCursor;
  onCursorChange: (cursor: MonthCursor) => void;
  entries: EntryDetail[];
  loading: boolean;
  selectedDay: string | null;
  onSelectDay: (date: string) => void;
}

export function MonthView({
  cursor,
  onCursorChange,
  entries,
  loading,
  selectedDay,
  onSelectDay,
}: Props) {
  const totals = useMemo(() => {
    const byDay = new Map<string, DayTotal>();
    for (const entry of entries) {
      const day = entry.startedAt.slice(0, 10);
      const running = byDay.get(day) ?? { minutes: 0, cents: 0 };
      byDay.set(day, {
        minutes: running.minutes + entry.durationMinutes,
        cents: running.cents + sumEarnedCents([entry]),
      });
    }
    return byDay;
  }, [entries]);

  const monthMinutes = entries.reduce((sum, entry) => sum + entry.durationMinutes, 0);
  const monthCents = sumEarnedCents(entries);
  const cells = monthGrid(cursor);
  const today = todayIso();
  const onCurrentMonth = isSameMonth(cursor, currentMonth());

  return (
    <>
      <header className="month-head">
        <div className="month-nav">
          <Button variant="step" onClick={() => onCursorChange(shiftMonth(cursor, -1))} aria-label="Previous month">
            ‹
          </Button>
          <span className="month-title">{monthLabel(cursor)}</span>
          <Button variant="step" onClick={() => onCursorChange(shiftMonth(cursor, 1))} aria-label="Next month">
            ›
          </Button>
          {!onCurrentMonth && (
            <Button variant="quiet" onClick={() => onCursorChange(currentMonth())}>
              Today
            </Button>
          )}
        </div>

        {/* No captions: the units say what these are. The labels stay as
            accessible names so the figures are not two bare numbers to a
            screen reader. */}
        <div className="figures">
          <span
            className={`figure-value${monthMinutes === 0 ? " is-muted" : ""}`}
            aria-label={`${formatMinutes(monthMinutes)} tracked this month`}
          >
            {formatMinutes(monthMinutes)}
          </span>
          <span
            className={`figure-value${monthCents === 0 ? " is-muted" : ""}`}
            aria-label={`${formatMoney(monthCents)} earned this month`}
          >
            {formatMoney(monthCents)}
          </span>
        </div>
      </header>

      <div className="weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="grid" role="grid" aria-label={`${monthLabel(cursor)} calendar`}>
        {cells.map((date, index) => {
          if (date === null) {
            return <div key={`blank-${index}`} className="cell is-blank" role="presentation" />;
          }

          const total = totals.get(date);
          const minutes = total?.minutes ?? 0;
          // A short day still shows a visible sliver, so "has hours" always reads.
          const bandHeight =
            minutes === 0
              ? 0
              : BAND_MIN_PERCENT +
                Math.min(minutes / FULL_DAY_MINUTES, 1) * (BAND_MAX_PERCENT - BAND_MIN_PERCENT);

          const classes = [
            "cell",
            minutes > 0 ? "has-hours" : "",
            isWeekend(date) ? "is-weekend" : "",
            date === today ? "is-today" : "",
            date === selectedDay ? "is-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              key={date}
              type="button"
              className={classes}
              onClick={() => onSelectDay(date)}
              aria-label={`${date}, ${minutes === 0 ? "no time logged" : formatMinutes(minutes)}`}
              aria-pressed={date === selectedDay}
            >
              {bandHeight > 0 && (
                <span className="cell-band" style={{ height: `${bandHeight}%` }} aria-hidden="true" />
              )}
              <span className="cell-head">
                <span className="cell-date">{dayOfMonth(date)}</span>
                {total && (
                  <span className="cell-figures">
                    <span className="cell-hours">{formatMinutes(total.minutes)}</span>
                    {total.cents > 0 && (
                      <span className="cell-money">{formatMoneyCompact(total.cents)}</span>
                    )}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {loading && <p className="loading">Loading {monthLabel(cursor)}…</p>}
    </>
  );
}
