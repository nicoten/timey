import { useMemo } from "react";

import type { EntryDetail } from "../lib/api";
import {
  WEEKDAY_LABELS,
  currentMonth,
  dayLabel,
  dayOfMonth,
  isSameMonth,
  monthGrid,
  monthLabel,
  shiftMonth,
  todayIso,
  type MonthCursor,
} from "../lib/dates";
import { intensityLevel } from "../lib/intensity";
import { formatMinutes, formatMoney, sumEarnedCents } from "../lib/money";
import { Button, HoverTip } from "./ui";

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
          <Button
            variant="step"
            onClick={() => onCursorChange(shiftMonth(cursor, -1))}
            aria-label="Previous month"
          >
            ‹
          </Button>
          <span className="month-title">{monthLabel(cursor)}</span>
          <Button
            variant="step"
            onClick={() => onCursorChange(shiftMonth(cursor, 1))}
            aria-label="Next month"
          >
            ›
          </Button>
          {!onCurrentMonth && (
            <Button variant="quiet" onClick={() => onCursorChange(currentMonth())}>
              Today
            </Button>
          )}
        </div>

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

      <div className="grid">
        {cells.map((date, index) => {
          if (date === null) {
            return <div key={`blank-${index}`} className="day-slot" />;
          }

          const total = totals.get(date);
          const minutes = total?.minutes ?? 0;
          const cents = total?.cents ?? 0;
          const level = intensityLevel(minutes);

          const summary =
            minutes === 0
              ? "nothing logged"
              : cents > 0
                ? `${formatMinutes(minutes)} · ${formatMoney(cents)}`
                : formatMinutes(minutes);

          const classes = [
            "day",
            `level-${level}`,
            date === today ? "is-today" : "",
            date === selectedDay ? "is-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const button = (
            <button
              type="button"
              className={classes}
              onClick={() => onSelectDay(date)}
              // The tooltip is hover-only, so the same facts go in the
              // accessible name for anyone not using a pointer.
              aria-label={`${dayLabel(date)}, ${summary}`}
              aria-pressed={date === selectedDay}
            >
              {dayOfMonth(date)}
            </button>
          );

          return (
            <div key={date} className="day-slot">
              {/* A tooltip saying "nothing logged" is noise, so empty days get none. */}
              {minutes === 0 ? button : <HoverTip label={summary}>{button}</HoverTip>}
            </div>
          );
        })}
      </div>

      {loading && <p className="loading">Loading {monthLabel(cursor)}…</p>}
    </>
  );
}
