import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Checkbox } from "radix-ui";

import {
  importCommit,
  importDuplicates,
  importRead,
  popoverResize,
  type Client,
  type FixedEntryInput,
  type ImportPreview,
  type Project,
} from "../lib/api";
import { DEFAULT_CURRENCY, formatMoney, parseAmountToCents } from "../lib/money";
import { Button, Dropdown, DropdownField, Empty, ErrorNote, Modal, TextInput } from "./ui";

/** The popover's size from `tauri.conf.json`, and the size a review table needs. */
const NORMAL_SIZE = { width: 460, height: 372 } as const;
// Kept under the 820px breakpoint, so the month behind the scrim keeps its layout.
const IMPORT_SIZE = { width: 800, height: 540 } as const;

/** A row's project when it follows the picker at the top. */
const FOLLOW_DEFAULT = "default";

interface Draft {
  sourceRow: number;
  include: boolean;
  date: string;
  name: string;
  /** As typed. */
  amount: string;
  /** A project id, or `FOLLOW_DEFAULT`. */
  project: string;
  /** What the sheet says the money is in, if it says. */
  currency: string | null;
}

/** The row as it would be stored, or what is wrong with it. */
function resolve(draft: Draft, defaultProject: string): FixedEntryInput | string {
  const project = draft.project === FOLLOW_DEFAULT ? defaultProject : draft.project;
  if (project === "") return "Choose a project.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return "Enter a date.";
  if (draft.name.trim() === "") return "Describe the work.";

  let amountCents: number;
  try {
    // A decimal comma, as a Spanish keyboard types it, rather than grouping:
    // "4878,90" is not four hundred thousand.
    amountCents = parseAmountToCents(draft.amount.trim().replace(/^(\d+),(\d{1,2})$/, "$1.$2"));
  } catch (caught) {
    return caught instanceof Error ? caught.message : "Enter an amount.";
  }
  if (amountCents <= 0) return "Enter an amount greater than zero.";

  return { projectId: Number(project), name: draft.name.trim(), date: draft.date, amountCents };
}

/** Enter commits the dialog, which is the wrong thing halfway down a table. */
function holdEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter") event.preventDefault();
}

interface Props {
  path: string;
  clients: Client[];
  /** Live projects only. */
  projects: Project[];
  onClose: () => void;
  onImported: (count: number) => void;
}

export function ImportDialog({ path, clients, projects, onClose, onImported }: Props) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [defaultProject, setDefaultProject] = useState("");
  const [description, setDescription] = useState("");
  const [duplicates, setDuplicates] = useState<boolean[]>([]);
  const [readError, setReadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const clientsById = useMemo(() => new Map(clients.map((client) => [client.id, client])), [clients]);
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  // Widen for the table, and put the window back however the dialog closes.
  useEffect(() => {
    void popoverResize(IMPORT_SIZE.width, IMPORT_SIZE.height).catch(() => {});
    return () => {
      void popoverResize(NORMAL_SIZE.width, NORMAL_SIZE.height).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let current = true;
    importRead(path)
      .then(async (read) => {
        if (!current) return;

        // Start on a project billed in the sheet's currency, when there is one.
        const sheetCurrency = read.rows.find((row) => row.currency !== null)?.currency ?? null;
        const preferred =
          projects.find((project) => clientsById.get(project.clientId)?.currency === sheetCurrency) ??
          projects[0];
        const project = preferred ? String(preferred.id) : "";

        const initial: Draft[] = read.rows.map((row) => ({
          sourceRow: row.sourceRow,
          include: true,
          date: row.date,
          name: row.description,
          amount: (row.amountCents / 100).toFixed(2),
          project: FOLLOW_DEFAULT,
          currency: row.currency,
        }));

        // Payments already imported from an earlier, overlapping export start
        // unchecked, so importing the new file again is safe.
        if (project !== "") {
          const found = await importDuplicates(
            read.rows.map((row) => ({
              projectId: Number(project),
              name: row.description,
              date: row.date,
              amountCents: row.amountCents,
            })),
          ).catch(() => [] as boolean[]);
          initial.forEach((draft, index) => {
            if (found[index]) draft.include = false;
          });
        }
        if (!current) return;

        setPreview(read);
        setDefaultProject(project);
        setDrafts(initial);
      })
      .catch((caught) => {
        if (current) setReadError(caught);
      });
    return () => {
      current = false;
    };
    // Read once per file; the catalog changing underneath is not a reason to
    // throw away edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const resolved = drafts.map((draft) => resolve(draft, defaultProject));

  // Re-check for earlier imports whenever what identifies a payment changes.
  const probeKey = JSON.stringify(
    resolved.map((row) => (typeof row === "string" ? null : [row.projectId, row.date, row.amountCents])),
  );
  useEffect(() => {
    const probes = resolved.map((row) =>
      typeof row === "string" ? { projectId: 0, name: "", date: "", amountCents: 0 } : row,
    );
    if (probes.length === 0) return;
    let current = true;
    importDuplicates(probes)
      .then((found) => {
        if (current) setDuplicates(found);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey]);

  function update(index: number, change: Partial<Draft>) {
    setDrafts((previous) =>
      previous.map((draft, at) => (at === index ? { ...draft, ...change } : draft)),
    );
  }

  /** The currency of the client a project bills, which is what its amounts are in. */
  function currencyOf(projectId: number): string {
    const project = projectsById.get(projectId);
    return clientsById.get(project?.clientId ?? -1)?.currency ?? DEFAULT_CURRENCY;
  }

  function projectOf(draft: Draft): number {
    return Number(draft.project === FOLLOW_DEFAULT ? defaultProject : draft.project);
  }

  const included = drafts
    .map((draft, index) => ({ draft, row: resolved[index] }))
    .filter(({ draft }) => draft.include);
  const ready = included
    .map(({ row }) => row)
    .filter((row): row is FixedEntryInput => typeof row !== "string");
  const invalidCount = included.length - ready.length;

  const totals = new Map<string, number>();
  for (const row of ready) {
    const currency = currencyOf(row.projectId);
    totals.set(currency, (totals.get(currency) ?? 0) + row.amountCents);
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const created = await importCommit(ready);
      onImported(created.length);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const projectOptions = projects.map((project) => {
    const client = clientsById.get(project.clientId);
    return {
      value: String(project.id),
      label: `${project.code} — ${project.name}${client ? ` (${client.name})` : ""}`,
    };
  });
  const defaultCode = projectsById.get(Number(defaultProject))?.code ?? "—";
  const rowProjectOptions = [
    { value: FOLLOW_DEFAULT, label: `${defaultCode} (default)` },
    ...projects.map((project) => ({ value: String(project.id), label: project.code })),
  ];

  const fileName = path.split("/").pop() ?? path;

  if (readError !== null) {
    return (
      <Modal title="Import payments" submitLabel="Close" onSubmit={onClose} onClose={onClose} wide>
        <p className="ledger-sub" style={{ wordBreak: "break-all" }}>
          {fileName}
        </p>
        <ErrorNote error={readError} />
      </Modal>
    );
  }

  if (preview === null) {
    return (
      <Modal title="Import payments" submitLabel="Import" onSubmit={() => {}} onClose={onClose} canSubmit={false} wide>
        <p className="loading">Reading {fileName}…</p>
      </Modal>
    );
  }

  if (projects.length === 0) {
    return (
      <Modal title="Import payments" submitLabel="Close" onSubmit={onClose} onClose={onClose} wide>
        <Empty title="No projects yet">
          <p>Each payment becomes an entry on a project. Add one in Settings first.</p>
        </Empty>
      </Modal>
    );
  }

  const detected = [preview.columns.date, preview.columns.description, preview.columns.amount]
    .filter((column): column is string => column !== null)
    .join(" · ");
  const found = `${preview.rows.length} ${preview.rows.length === 1 ? "payment" : "payments"}`;
  const skipped =
    preview.skippedOutgoing > 0 ? `, ${preview.skippedOutgoing} outgoing left out` : "";

  const submitLabel = busy
    ? "Importing…"
    : invalidCount > 0
      ? `${invalidCount} ${invalidCount === 1 ? "row needs" : "rows need"} fixing`
      : `Import ${ready.length} ${ready.length === 1 ? "entry" : "entries"}${
          totals.size > 0
            ? ` · ${[...totals].map(([currency, cents]) => formatMoney(cents, currency)).join(" + ")}`
            : ""
        }`;

  return (
    <Modal
      title="Import payments"
      submitLabel={submitLabel}
      onSubmit={() => void commit()}
      onClose={onClose}
      canSubmit={ready.length > 0 && invalidCount === 0 && !busy}
      busy={busy}
      wide
    >
      <p className="ledger-sub">
        {fileName} — detected {detected}: {found}
        {skipped}.
      </p>

      <div className="import-controls">
        <DropdownField
          label="Project"
          inline
          value={defaultProject}
          onChange={setDefaultProject}
          options={projectOptions}
          placeholder="Choose a project"
        />
        <div className="field is-inline">
          <span>Description</span>
          <div className="import-apply">
            <TextInput
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={holdEnter}
              placeholder="The work these payments were for"
              aria-label="Description for every checked row"
            />
            <Button
              disabled={description.trim() === ""}
              onClick={() =>
                setDrafts((previous) =>
                  previous.map((draft) => (draft.include ? { ...draft, name: description } : draft)),
                )
              }
            >
              Apply to checked
            </Button>
          </div>
        </div>
      </div>

      {drafts.length === 0 ? (
        <Empty title="No incoming payments">
          <p>Every dated row in this sheet had an amount of zero or less.</p>
        </Empty>
      ) : (
        <div className="import-table" role="table" aria-label="Payments to import">
          <div className="import-row is-head" role="row">
            <span role="columnheader" aria-label="Include" />
            <span role="columnheader">Date</span>
            <span role="columnheader">Description</span>
            <span role="columnheader">Amount</span>
            <span role="columnheader">Project</span>
          </div>
          {drafts.map((draft, index) => {
            const row = resolved[index];
            const problem = draft.include && typeof row === "string" ? row : null;
            const currency = currencyOf(projectOf(draft));
            const mismatch = draft.currency !== null && draft.currency !== currency;
            const notes = [
              duplicates[index] ? "Already imported: an entry with this project, day and amount exists." : null,
              mismatch ? `The sheet says ${draft.currency}; this client is billed in ${currency}.` : null,
              problem,
            ].filter((note): note is string => note !== null);

            return (
              <div
                key={draft.sourceRow}
                role="row"
                className={`import-row${draft.include ? "" : " is-excluded"}${problem ? " is-invalid" : ""}`}
              >
                <span role="cell">
                  <Checkbox.Root
                    className="check-box"
                    checked={draft.include}
                    onCheckedChange={(next) => update(index, { include: next === true })}
                    aria-label={`Import row ${draft.sourceRow}`}
                  >
                    <Checkbox.Indicator className="check-mark">✓</Checkbox.Indicator>
                  </Checkbox.Root>
                </span>
                <span role="cell">
                  <TextInput
                    type="date"
                    className="num"
                    value={draft.date}
                    onChange={(event) => update(index, { date: event.target.value })}
                    onKeyDown={holdEnter}
                    aria-label={`Date, row ${draft.sourceRow}`}
                  />
                </span>
                <span role="cell">
                  <TextInput
                    value={draft.name}
                    onChange={(event) => update(index, { name: event.target.value })}
                    onKeyDown={holdEnter}
                    aria-label={`Description, row ${draft.sourceRow}`}
                  />
                </span>
                <span role="cell" className="import-amount">
                  <TextInput
                    className="num"
                    inputMode="decimal"
                    value={draft.amount}
                    onChange={(event) => update(index, { amount: event.target.value })}
                    onKeyDown={holdEnter}
                    aria-label={`Amount in ${currency}, row ${draft.sourceRow}`}
                  />
                  <span className="import-currency">{currency}</span>
                </span>
                <span role="cell">
                  <Dropdown
                    mono
                    ariaLabel={`Project, row ${draft.sourceRow}`}
                    value={draft.project}
                    onChange={(project) => update(index, { project })}
                    options={rowProjectOptions}
                  />
                </span>
                {notes.length > 0 && (
                  <ul className="import-notes" role="cell">
                    {notes.map((note) => (
                      <li key={note} className={note === problem ? "is-problem" : undefined}>
                        {note}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ErrorNote error={error} />
    </Modal>
  );
}
