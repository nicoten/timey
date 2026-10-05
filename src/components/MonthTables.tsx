import { useMemo } from "react";

import type { EntryDetail } from "../lib/api";
import { dayLabel, shortDayLabel } from "../lib/dates";
import { entryEarnedCents, formatMinutes, formatMoney } from "../lib/money";

/*
 * The month as tables, the alternatives to the calendar grid. Both take the
 * same entries the calendar does, so the header's totals always agree with them.
 */

interface EntriesTableProps {
  entries: EntryDetail[];
  selectedDay: string | null;
  onSelectEntry: (entry: EntryDetail) => void;
}

/** Every entry in the month, oldest first. A row opens that entry for editing. */
export function EntriesTable({ entries, selectedDay, onSelectEntry }: EntriesTableProps) {
  const rows = useMemo(
    () =>
      [...entries].sort(
        (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id,
      ),
    [entries],
  );

  if (rows.length === 0) return <p className="loading">Nothing logged this month.</p>;

  return (
    <table className="month-table">
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Client</th>
          <th scope="col">Entry</th>
          <th scope="col" className="is-num">
            Hours
          </th>
          <th scope="col" className="is-num">
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => {
          const day = entry.startedAt.slice(0, 10);
          const cents = entryEarnedCents(entry);
          return (
            <tr
              key={entry.id}
              className={`is-clickable${day === selectedDay ? " is-selected" : ""}`}
              onClick={() => onSelectEntry(entry)}
            >
              <td className="is-date">
                {/* The row's click is a convenience for the pointer; the
                    button is what a keyboard reaches. */}
                <button
                  type="button"
                  className="cell-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectEntry(entry);
                  }}
                  aria-label={`Edit ${entry.name}, ${dayLabel(day)}`}
                >
                  {shortDayLabel(day)}
                </button>
              </td>
              <td className="is-clip">{entry.clientName}</td>
              <td className="is-fill" title={entry.name}>
                {entry.name}
              </td>
              <td className="is-num">
                {entry.amountCents !== null ? "Fixed" : formatMinutes(entry.durationMinutes)}
              </td>
              <td className="is-num">{cents === null ? "—" : formatMoney(cents, entry.currency)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface ClientTotal {
  clientId: number;
  name: string;
  currency: string;
  entries: number;
  minutes: number;
  cents: number;
  /** Timed minutes on projects without a rate, which earn nothing yet. */
  unratedMinutes: number;
}

/** The month totalled per client, each in its own currency. */
export function ClientTable({ entries }: { entries: EntryDetail[] }) {
  const rows = useMemo(() => {
    const byClient = new Map<number, ClientTotal>();
    for (const entry of entries) {
      const total = byClient.get(entry.clientId) ?? {
        clientId: entry.clientId,
        name: entry.clientName,
        currency: entry.currency,
        entries: 0,
        minutes: 0,
        cents: 0,
        unratedMinutes: 0,
      };
      const cents = entryEarnedCents(entry);
      total.entries += 1;
      total.minutes += entry.durationMinutes;
      if (cents === null) total.unratedMinutes += entry.durationMinutes;
      else total.cents += cents;
      byClient.set(entry.clientId, total);
    }
    return [...byClient.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [entries]);

  if (rows.length === 0) return <p className="loading">Nothing logged this month.</p>;

  return (
    <table className="month-table">
      <thead>
        <tr>
          <th scope="col">Client</th>
          <th scope="col" className="is-num">
            Entries
          </th>
          <th scope="col" className="is-num">
            Hours
          </th>
          <th scope="col" className="is-num">
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.clientId}>
            <td className="is-fill">{row.name}</td>
            <td className="is-num">{row.entries}</td>
            <td className="is-num">{row.minutes === 0 ? "—" : formatMinutes(row.minutes)}</td>
            <td
              className="is-num"
              title={
                row.unratedMinutes > 0
                  ? `${formatMinutes(row.unratedMinutes)} on projects without a rate is not included`
                  : undefined
              }
            >
              {/* Nothing billable at all reads as a dash, as an unrated entry
                  does, rather than a total of zero with a footnote. */}
              {row.cents === 0 && row.unratedMinutes > 0
                ? "—"
                : `${formatMoney(row.cents, row.currency)}${row.unratedMinutes > 0 ? "*" : ""}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
