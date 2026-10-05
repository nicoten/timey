import { useEffect, useMemo, useState } from "react";
import { ToggleGroup } from "radix-ui";

import {
  DURATION_STEP_MINUTES,
  entryCreate,
  entryCreateFixed,
  entryDelete,
  entryUpdate,
  entryUpdateFixed,
  type EntryDetail,
  type Project,
  type Client,
} from "../lib/api";
import { combineDateAndTime, dayLabel, endTimeOfDay, timeOfDay } from "../lib/dates";
import {
  centsToRateInput,
  entryEarnedCents,
  formatMinutes,
  formatMoney,
  DEFAULT_CURRENCY,
  formatMoneyTotals,
  parseAmountToCents,
  sumEarned,
} from "../lib/money";
import {
  Button,
  Dropdown,
  Empty,
  ErrorNote,
  Field,
  SplitField,
  TextInput,
  type DropdownOption,
} from "./ui";

const DEFAULT_DURATION = 60;

/*
 * Start is picked as an hour and a minute rather than from one long list of
 * every combination; the hours are all 24, the minutes coarser at the half
 * hour. Duration is not picked at all — it steps by the quarter hour the
 * backend validates, which is the only size anything here moves by.
 */

const HOURS_OF_DAY: DropdownOption[] = Array.from({ length: 24 }, (_, hour) => {
  const value = String(hour).padStart(2, "0");
  return { value, label: value };
});

const START_MINUTES: DropdownOption[] = ["00", "30"].map((value) => ({ value, label: value }));

/** Twelve hours is the longest entry the app offers, as it always has been. */
const MAX_DURATION_HOURS = 12;
const MAX_DURATION_MINUTES = MAX_DURATION_HOURS * 60;

/*
 * A new entry starts at the top of the current hour: what gets logged is
 * usually what just happened, and 16:45 rounds down to 16:00 rather than
 * offering a time nobody would type.
 */
function currentHourStart(): string {
  return `${String(new Date().getHours()).padStart(2, "0")}:00`;
}

/** A request to open one entry for editing. A new object each time, so the same
 *  entry can be asked for twice in a row. */
export interface EntryFocus {
  entryId: number;
}

interface Props {
  date: string;
  /** Set when the panel was opened from a particular entry, such as a table row. */
  focus?: EntryFocus | null;
  entries: EntryDetail[];
  projects: Project[];
  clients: Client[];
  onClose: () => void;
  onChanged: () => void;
  onOpenSettings: () => void;
}

/*
 * A timed entry is billed by the hour; a fixed-price one at an agreed amount,
 * with no time at all. The draft keeps both sets of fields so switching back
 * and forth loses nothing typed.
 */
type EntryKind = "timed" | "fixed";

interface Draft {
  kind: EntryKind;
  projectId: string;
  name: string;
  startTime: string;
  durationMinutes: number;
  /** As typed, in the client's currency; parsed on submit. */
  amount: string;
}

export function DayPanel({
  date,
  focus = null,
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

  const emptyDraft = (): Draft => ({
    kind: "timed",
    projectId: projects[0] ? String(projects[0].id) : "",
    name: "",
    startTime: currentHourStart(),
    durationMinutes: DEFAULT_DURATION,
    amount: "",
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
      kind: "timed",
      projectId: projects[0] ? String(projects[0].id) : "",
      name: "",
      startTime: currentHourStart(),
      durationMinutes: DEFAULT_DURATION,
      amount: "",
    });
  }, [date, projects]);

  // Runs after the reset above, so a request arriving with a new day still wins.
  useEffect(() => {
    if (focus === null) return;
    const entry = entries.find((candidate) => candidate.id === focus.entryId);
    if (entry !== undefined) beginEdit(entry);
    // Only a new request should reopen an entry, not a reload of the month.
  }, [focus]);

  const startHour = draft.startTime.slice(0, 2);
  const startMinute = draft.startTime.slice(3, 5);

  const setStart = (hour: string, minute: string) =>
    setDraft({ ...draft, startTime: `${hour}:${minute}` });

  /*
   * The bounds are held by the buttons rather than by clamping here, so an
   * entry saved longer than the ceiling keeps its length and can only be
   * shortened.
   */
  const stepDuration = (delta: number) =>
    setDraft({ ...draft, durationMinutes: draft.durationMinutes + delta });

  /*
   * The half hour, plus the draft's own minute when it sits between: an entry
   * saved at :15 or :45 still opens for editing here. Radix shows an empty
   * trigger for a value it has no option for, and the time would vanish on
   * save.
   */
  const startMinuteOptions: DropdownOption[] = useMemo(() => {
    if (START_MINUTES.some((option) => option.value === startMinute)) return START_MINUTES;
    return [...START_MINUTES, { value: startMinute, label: startMinute }].sort((a, b) =>
      a.value.localeCompare(b.value),
    );
  }, [startMinute]);

  const dayMinutes = dayEntries.reduce((sum, entry) => sum + entry.durationMinutes, 0);
  const dayMoney = sumEarned(dayEntries);
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const clientsById = new Map(clients.map((client) => [client.id, client]));

  // The amount is in whatever the chosen project's client is billed in.
  const draftCurrency =
    clientsById.get(projectsById.get(Number(draft.projectId))?.clientId ?? -1)?.currency ??
    DEFAULT_CURRENCY;

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
    const fixed = entry.amountCents !== null;
    setDraft({
      kind: fixed ? "fixed" : "timed",
      projectId: String(entry.projectId),
      name: entry.name,
      // A fixed entry is stored at midnight with no duration; if it is switched
      // to timed, it starts from the same defaults as a new entry.
      startTime: fixed ? currentHourStart() : timeOfDay(entry.startedAt),
      durationMinutes: fixed ? DEFAULT_DURATION : entry.durationMinutes,
      amount: centsToRateInput(entry.amountCents),
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
      if (draft.kind === "fixed") {
        const fixed = {
          projectId: Number(draft.projectId),
          name: draft.name,
          date,
          // Throws a readable message on a malformed amount before anything is sent.
          amountCents: parseAmountToCents(draft.amount),
        };
        if (editingId === null) {
          await entryCreateFixed(fixed);
        } else {
          await entryUpdateFixed({ id: editingId, ...fixed });
        }
      } else {
        const timed = {
          projectId: Number(draft.projectId),
          name: draft.name,
          startedAt: combineDateAndTime(date, draft.startTime),
          durationMinutes: draft.durationMinutes,
        };
        if (editingId === null) {
          await entryCreate(timed);
        } else {
          await entryUpdate({ id: editingId, ...timed });
        }
      }
      setEditingId(null);
      // Stays on the kind just used: fixed prices tend to come several at once.
      setDraft({ ...emptyDraft(), kind: draft.kind });
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

  const canSubmit =
    draft.projectId !== "" &&
    draft.name.trim() !== "" &&
    (draft.kind === "timed" || draft.amount.trim() !== "") &&
    !busy;

  return (
    <aside className="panel" aria-label={`Entries for ${dayLabel(date)}`}>
      <div className="panel-head">
        <div>
          <div className="panel-title">{dayLabel(date)}</div>
          <div className="panel-total">
            {dayEntries.length === 0
              ? "No entries"
              : dayMinutes === 0
                ? formatMoneyTotals(dayMoney)
                : `${formatMinutes(dayMinutes)} · ${formatMoneyTotals(dayMoney)}`}
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
              const fixed = entry.amountCents !== null;
              const end = endTimeOfDay(entry.startedAt, entry.durationMinutes);
              const cents = entryEarnedCents(entry);
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
                      {!fixed && (
                        <span>
                          {timeOfDay(entry.startedAt)}–{end ?? "24:00"}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="entry-figures">
                    <span className="entry-duration">
                      {fixed ? "Fixed" : formatMinutes(entry.durationMinutes)}
                    </span>
                    <br />
                    <span className="entry-money">{cents === null ? "—" : formatMoney(cents, entry.currency)}</span>
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

            <ToggleGroup.Root
              className="segmented is-block"
              type="single"
              value={draft.kind}
              aria-label="Billed"
              onValueChange={(next) => {
                // Radix reports "" when the active item is pressed again; ignore
                // it so there is always exactly one selection.
                if (next !== "") setDraft({ ...draft, kind: next as EntryKind });
              }}
            >
              <ToggleGroup.Item className="segmented-item" value="timed">
                By the hour
              </ToggleGroup.Item>
              <ToggleGroup.Item className="segmented-item" value="fixed">
                Fixed price
              </ToggleGroup.Item>
            </ToggleGroup.Root>

            {draft.kind === "fixed" ? (
              <Field label={`Amount (${draftCurrency})`}>
                <TextInput
                  className="num"
                  inputMode="decimal"
                  value={draft.amount}
                  placeholder="0.00"
                  onChange={(event) => setDraft({ ...draft, amount: event.currentTarget.value })}
                />
              </Field>
            ) : (
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
                <div className="field">
                  <span>Duration</span>
                  <div className="stepper">
                    <Button
                      variant="step"
                      aria-label={`Shorten by ${DURATION_STEP_MINUTES} minutes`}
                      disabled={draft.durationMinutes <= DURATION_STEP_MINUTES}
                      onClick={() => stepDuration(-DURATION_STEP_MINUTES)}
                    >
                      −
                    </Button>
                    {/* Announced on change, since the buttons say what they do
                        but not what it did. */}
                    <span className="stepper-value" aria-live="polite">
                      {formatMinutes(draft.durationMinutes)}
                    </span>
                    <Button
                      variant="step"
                      aria-label={`Lengthen by ${DURATION_STEP_MINUTES} minutes`}
                      disabled={draft.durationMinutes >= MAX_DURATION_MINUTES}
                      onClick={() => stepDuration(DURATION_STEP_MINUTES)}
                    >
                      +
                    </Button>
                  </div>
                </div>
              </div>
            )}

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
