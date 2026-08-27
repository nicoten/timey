import { useEffect, useMemo, useState } from "react";

import {
  DURATION_OPTIONS,
  entryCreate,
  entryDelete,
  entryUpdate,
  type EntryDetail,
  type Project,
  type Client,
} from "../lib/api";
import {
  combineDateAndTime,
  dayLabel,
  endTimeOfDay,
  startTimeSlots,
  timeOfDay,
} from "../lib/dates";
import { earnedCents, formatMinutes, formatMoney, sumEarnedCents } from "../lib/money";
import {
  Button,
  Dropdown,
  DropdownField,
  Empty,
  ErrorNote,
  TextInput,
  type DropdownOption,
} from "./ui";

const DEFAULT_START = "09:00";
const DEFAULT_DURATION = 60;

const START_OPTIONS: DropdownOption[] = startTimeSlots().map((slot) => ({
  value: slot,
  label: slot,
}));

const DURATION_CHOICES: DropdownOption[] = DURATION_OPTIONS.map((minutes) => ({
  value: String(minutes),
  label: formatMinutes(minutes),
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
              <DropdownField
                label="Start"
                mono
                value={draft.startTime}
                onChange={(startTime) => setDraft({ ...draft, startTime })}
                options={START_OPTIONS}
              />
              <DropdownField
                label="Duration"
                mono
                value={String(draft.durationMinutes)}
                onChange={(minutes) =>
                  setDraft({ ...draft, durationMinutes: Number(minutes) })
                }
                options={DURATION_CHOICES}
              />
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
