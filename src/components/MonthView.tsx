import { useMemo } from "react";

import type { EntryDetail } from "../lib/api";
import {
  WEEKDAY_LABELS,
  dayLabel,
  dayOfMonth,
  isSameMonth,
  monthGrid,
  monthLabel,
  monthOf,
  shiftMonth,
  type MonthCursor,
} from "../lib/dates";
import { intensityLevel } from "../lib/intensity";
import {
  formatMinutes,
  formatMoneyTotals,
  isZeroTotals,
  sumEarned,
  type MoneyTotals,
} from "../lib/money";
import type { MonthMode } from "../lib/monthMode";
import { ClientTable, EntriesTable } from "./MonthTables";
import { Button, HoverTip } from "./ui";

interface DayTotal {
  minutes: number;
  money: MoneyTotals;
}

interface Props {
  /** `YYYY-MM-DD`; owned by App so it can be refreshed while the page lives on. */
  today: string;
  cursor: MonthCursor;
  onCursorChange: (cursor: MonthCursor) => void;
  entries: EntryDetail[];
  loading: boolean;
  selectedDay: string | null;
  onSelectDay: (date: string) => void;
  onSelectEntry: (entry: EntryDetail) => void;
  mode: MonthMode;
}

export function MonthView({
  mode,
  today,
  cursor,
  onCursorChange,
  entries,
  loading,
  selectedDay,
  onSelectDay,
  onSelectEntry,
}: Props) {
  const totals = useMemo(() => {
    const byDay = new Map<string, typeof entries>();
    for (const entry of entries) {
      const day = entry.startedAt.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    }
    return new Map<string, DayTotal>(
      [...byDay].map(([day, dayEntries]) => [
        day,
        {
          minutes: dayEntries.reduce((sum, entry) => sum + entry.durationMinutes, 0),
          money: sumEarned(dayEntries),
        },
      ]),
    );
  }, [entries]);

  const monthMinutes = entries.reduce((sum, entry) => sum + entry.durationMinutes, 0);
  const monthMoney = sumEarned(entries);
  const cells = monthGrid(cursor);
  const onCurrentMonth = isSameMonth(cursor, monthOf(today));

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
            <Button variant="quiet" onClick={() => onCursorChange(monthOf(today))}>
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
            className={`figure-value is-earned${isZeroTotals(monthMoney) ? " is-muted" : ""}`}
            aria-label={`${formatMoneyTotals(monthMoney)} earned this month`}
          >
            {formatMoneyTotals(monthMoney)}
          </span>
        </div>
      </header>

      {mode === "entries" ? (
        <EntriesTable entries={entries} selectedDay={selectedDay} onSelectEntry={onSelectEntry} />
      ) : mode === "clients" ? (
        <ClientTable entries={entries} />
      ) : (
        <>
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
              const money: MoneyTotals = total?.money ?? new Map();
              const earned = !isZeroTotals(money);
              const level = intensityLevel(minutes);

              // A day holding only fixed-price work has money but no hours.
              const logged = minutes > 0 || earned;
              const summary = !logged
                ? "nothing logged"
                : minutes === 0
                  ? formatMoneyTotals(money)
                  : earned
                    ? `${formatMinutes(minutes)} · ${formatMoneyTotals(money)}`
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
                  {logged ? <HoverTip label={summary}>{button}</HoverTip> : button}
                </div>
              );
            })}
          </div>
        </>
      )}

      {loading && <p className="loading">Loading {monthLabel(cursor)}…</p>}
    </>
  );
}
