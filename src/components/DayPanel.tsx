import { useEffect, useMemo, useState } from "react";

import {
  DURATION_STEP_MINUTES,
  entryCreate,
  entryDelete,
  entryUpdate,
  type EntryDetail,
  type Project,
  type Client,
} from "../lib/api";
import { combineDateAndTime, dayLabel, endTimeOfDay, timeOfDay } from "../lib/dates";
import { earnedCents, formatMinutes, formatMoney, sumEarnedCents } from "../lib/money";
import {
  Button,
  Dropdown,
  Empty,
  ErrorNote,
  SplitField,
  TextInput,
  type DropdownOption,
} from "./ui";

const DEFAULT_START = "09:00";
const DEFAULT_DURATION = 60;

/*
 * Start and duration are each picked as an hour and a minute rather than from
 * one long list of every combination. Both parts stay on the quarter-hour grid
 * the backend validates; the start minutes are coarser still, at the half hour.
 */

const HOURS_OF_DAY: DropdownOption[] = Array.from({ length: 24 }, (_, hour) => {
  const value = String(hour).padStart(2, "0");
  return { value, label: value };
});

const START_MINUTES: DropdownOption[] = ["00", "30"].map((value) => ({ value, label: value }));

/** Twelve hours is the longest entry the app offers, as it always has been. */
const MAX_DURATION_HOURS = 12;

const DURATION_HOURS: DropdownOption[] = Array.from(
  { length: MAX_DURATION_HOURS + 1 },
  (_, hours) => ({ value: String(hours), label: `${hours}h` }),
);

const DURATION_MINUTES: DropdownOption[] = [0, 15, 30, 45].map((minutes) => ({
  value: String(minutes),
  label: `${minutes}m`,
}));

interface Props {
  date: string;
  entries: EntryDetail[];
  projects: Project[];
  clients: Client[];
  onClose: () => void;
  onChanged: () => void;
  onOpenSettings: () => void;
}

interface Draft {
  projectId: string;
  name: string;
  startTime: string;
  durationMinutes: number;
}

export function DayPanel({
  date,
  entries,
  projects,
  clients,
  onClose,
  onChanged,
  onOpenSettings,
}: Props) {
  const dayEntries = useMemo(
    () =>
      entries
        .filter((entry) => entry.startedAt.startsWith(date))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [entries, date],
  );

  /** The first free slot after the day's last entry, so consecutive logging flows. */
  const suggestedStart = useMemo(() => {
    const last = dayEntries.at(-1);
    if (!last) return DEFAULT_START;
    return endTimeOfDay(last.startedAt, last.durationMinutes) ?? DEFAULT_START;
  }, [dayEntries]);

  const emptyDraft = (): Draft => ({
    projectId: projects[0] ? String(projects[0].id) : "",
    name: "",
    startTime: suggestedStart,
    durationMinutes: DEFAULT_DURATION,
  });

  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Moving to another day resets the form rather than carrying a stale draft over.
  useEffect(() => {
    setEditingId(null);
    setError(null);
    setDraft({
      projectId: projects[0] ? String(projects[0].id) : "",
      name: "",
      startTime: suggestedStart,
      durationMinutes: DEFAULT_DURATION,
    });
  }, [date, suggestedStart, projects]);

  const startHour = draft.startTime.slice(0, 2);
  const startMinute = draft.startTime.slice(3, 5);
  const durationHours = Math.floor(draft.durationMinutes / 60);
  const durationMinutes = draft.durationMinutes % 60;

  const setStart = (hour: string, minute: string) =>
    setDraft({ ...draft, startTime: `${hour}:${minute}` });

  const setDuration = (hours: number, minutes: number) =>
    setDraft({ ...draft, durationMinutes: hours * 60 + minutes });

  /*
   * The half hour, plus the draft's own minute when it sits between: durations
   * still step by 15, so a start suggested after a 45-minute entry lands on :45,
   * as does any entry already saved there. Radix shows an empty trigger for a
   * value it has no option for, and the time would vanish on save.
   */
  const startMinuteOptions: DropdownOption[] = useMemo(() => {
    if (START_MINUTES.some((option) => option.value === startMinute)) return START_MINUTES;
    return [...START_MINUTES, { value: startMinute, label: startMinute }].sort((a, b) =>
      a.value.localeCompare(b.value),
    );
  }, [startMinute]);

  /** Likewise for a longer entry than the app itself offers. */
  const durationHourOptions: DropdownOption[] = useMemo(() => {
    if (durationHours <= MAX_DURATION_HOURS) return DURATION_HOURS;
    return [...DURATION_HOURS, { value: String(durationHours), label: `${durationHours}h` }];
  }, [durationHours]);

  /*
   * A duration has to be positive and no longer than the ceiling, so the minutes
   * that would break either rule are greyed rather than dropped — the constraint
   * is easier to understand when you can see what it excludes.
   */
  const durationMinuteOptions: DropdownOption[] = useMemo(
    () =>
      DURATION_MINUTES.map((option) => ({
        ...option,
        disabled:
          option.value === "0" ? durationHours === 0 : durationHours >= MAX_DURATION_HOURS,
      })),
    [durationHours],
  );

  /*
   * Changing the hour never dead-ends on those same rules: it carries the
   * minutes to the nearest value the new hour allows instead of refusing.
   */
  const changeDurationHours = (hours: number) => {
    if (hours === 0) return setDuration(0, durationMinutes || DURATION_STEP_MINUTES);
    if (hours >= MAX_DURATION_HOURS) return setDuration(hours, 0);
    setDuration(hours, durationMinutes);
  };

  const dayMinutes = dayEntries.reduce((sum, entry) => sum + entry.durationMinutes, 0);
  const dayCents = sumEarnedCents(dayEntries);
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const clientsById = new Map(clients.map((client) => [client.id, client]));

  const projectOptions: DropdownOption[] = projects.map((project) => {
    const client = clientsById.get(project.clientId);
    return {
      value: String(project.id),
      label: `${project.code} — ${project.name}${client ? ` (${client.name})` : ""}`,
    };
  });

  function beginEdit(entry: EntryDetail) {
    setEditingId(entry.id);
    setError(null);
    setDraft({
      projectId: String(entry.projectId),
      name: entry.name,
      startTime: timeOfDay(entry.startedAt),
      durationMinutes: entry.durationMinutes,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
    setDraft(emptyDraft());
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const shared = {
        projectId: Number(draft.projectId),
        name: draft.name,
        startedAt: combineDateAndTime(date, draft.startTime),
        durationMinutes: draft.durationMinutes,
      };
      if (editingId === null) {
        await entryCreate(shared);
      } else {
        await entryUpdate({ id: editingId, ...shared });
      }
      setEditingId(null);
      setDraft(emptyDraft());
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (editingId === null) return;
    setBusy(true);
    setError(null);
    try {
      await entryDelete(editingId);
      setEditingId(null);
      setDraft(emptyDraft());
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = draft.projectId !== "" && draft.name.trim() !== "" && !busy;

  return (
    <aside className="panel" aria-label={`Entries for ${dayLabel(date)}`}>
      <div className="panel-head">
        <div>
          <div className="panel-title">{dayLabel(date)}</div>
          <div className="panel-total">
            {dayEntries.length === 0
              ? "No entries"
              : `${formatMinutes(dayMinutes)} · ${formatMoney(dayCents)}`}
          </div>
        </div>
        <Button variant="quiet" onClick={onClose} aria-label="Close day">
          ✕
        </Button>
      </div>

      <div className="panel-body">
        {dayEntries.length > 0 && (
          <div className="entries">
            {dayEntries.map((entry) => {
              const end = endTimeOfDay(entry.startedAt, entry.durationMinutes);
              const cents = earnedCents(entry.hourlyRateCents, entry.durationMinutes);
              const color = projectsById.get(entry.projectId)?.color;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`entry${editingId === entry.id ? " is-editing" : ""}`}
                  onClick={() => (editingId === entry.id ? cancelEdit() : beginEdit(entry))}
                >
                  <span>
                    <span className="entry-name">{entry.name}</span>
                    <span className="entry-meta">
                      <span
                        className="swatch"
                        style={color ? { background: color } : undefined}
                        aria-hidden="true"
                      />
                      <span className="entry-code">{entry.projectCode}</span>
                      <span>
                        {timeOfDay(entry.startedAt)}–{end ?? "24:00"}
                      </span>
                    </span>
                  </span>
                  <span className="entry-figures">
                    <span className="entry-duration">{formatMinutes(entry.durationMinutes)}</span>
                    <br />
                    <span className="entry-money">{cents === null ? "—" : formatMoney(cents)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {projects.length === 0 ? (
          <Empty title="No projects yet">
            <p>Time is logged against a project. Create a client and a project first.</p>
            <Button variant="primary" onClick={onOpenSettings}>
              Open settings
            </Button>
          </Empty>
        ) : (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="form-head">
              <span className="eyebrow">{editingId === null ? "Add entry" : "Edit entry"}</span>
              {editingId !== null && (
                <Button variant="quiet" onClick={cancelEdit}>
                  Add a new one instead
                </Button>
              )}
            </div>

            {/* No caption: the options show a code and a name, which says what
                this is more clearly than the word "Project" would. */}
            <Dropdown
              ariaLabel="Project"
              value={draft.projectId}
              onChange={(projectId) => setDraft({ ...draft, projectId })}
              options={projectOptions}
            />

            <TextInput
              value={draft.name}
              placeholder="What did you work on?"
              aria-label="What did you work on?"
              onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
            />

            <div className="field-pair">
              <SplitField label="Start">
                <Dropdown
                  ariaLabel="Start hour"
                  mono
                  value={startHour}
                  onChange={(hour) => setStart(hour, startMinute)}
                  options={HOURS_OF_DAY}
                />
                <span className="split-sep" aria-hidden="true">
                  :
                </span>
                <Dropdown
                  ariaLabel="Start minute"
                  mono
                  value={startMinute}
                  onChange={(minute) => setStart(startHour, minute)}
                  options={startMinuteOptions}
                />
              </SplitField>
              <SplitField label="Duration">
                <Dropdown
                  ariaLabel="Duration hours"
                  mono
                  value={String(durationHours)}
                  onChange={(hours) => changeDurationHours(Number(hours))}
                  options={durationHourOptions}
                />
                <Dropdown
                  ariaLabel="Duration minutes"
                  mono
                  value={String(durationMinutes)}
                  onChange={(minutes) => setDuration(durationHours, Number(minutes))}
                  options={durationMinuteOptions}
                />
              </SplitField>
            </div>

            <ErrorNote error={error} />

            <Button type="submit" variant="primary" block disabled={!canSubmit}>
              {editingId === null ? "Add entry" : "Save changes"}
            </Button>

            {editingId !== null && (
              <div className="form-actions">
                <Button variant="quiet" onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                  Delete
                </Button>
              </div>
            )}
          </form>
        )}
      </div>
    </aside>
  );
}
