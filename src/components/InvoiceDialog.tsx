import { useEffect, useMemo, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import {
  SETTING_INVOICE_FOLDER,
  SETTING_SENDER_NAME,
  hoursDecimal,
  invoiceCandidates,
  invoiceEmail,
  invoiceIssueMany,
  invoiceLabel,
  invoicePrepareMany,
  invoicesIssued,
  type Client,
  type InvoiceCandidate,
  type EmailAction,
  type IssuedInvoice,
  type IssuedInvoiceSummary,
  type Settings,
} from "../lib/api";
import {
  currentMonth,
  dayLabel,
  monthEndExclusive,
  monthLabel,
  monthOf,
  monthStart,
  shiftMonth,
} from "../lib/dates";
import { renderInvoicePdf } from "../lib/invoicePdf";
import { DEFAULT_CURRENCY, formatMinutes, formatMoney } from "../lib/money";
import {
  Button,
  CheckRow,
  Dropdown,
  DropdownField,
  Empty,
  ErrorNote,
  Modal,
  SplitField,
  type DropdownOption,
} from "./ui";

/** How far back the month picker offers. */
const MONTHS_OFFERED = 18;

/** Timed minutes cannot be billed without a rate; fixed prices always can. */
function isBillable(candidate: InvoiceCandidate): boolean {
  return candidate.minutes === 0 || candidate.hourlyRateCents !== null;
}

/** What a project's lines will come to, matching the backend's rounding. */
function candidateCents(candidate: InvoiceCandidate): number {
  const timed = Math.round(((candidate.hourlyRateCents ?? 0) * candidate.minutes) / 60);
  return timed + candidate.fixedCents;
}

/** One line for the project's time, plus one per fixed-price entry. */
function candidateLines(candidate: InvoiceCandidate): number {
  return (candidate.minutes > 0 ? 1 : 0) + candidate.fixedCount;
}

/** `17.50h · $2,712.50`, or just the money when there is no time. */
function candidateSummary(candidate: InvoiceCandidate, currency: string): string {
  const money = formatMoney(candidateCents(candidate), currency);
  return candidate.minutes > 0 ? `${hoursDecimal(candidate.minutes)}h · ${money}` : money;
}

/** Invoices whose period overlaps `[from, to)`. */
function overlapping(issued: IssuedInvoiceSummary[], from: string, to: string): IssuedInvoiceSummary[] {
  return issued.filter((invoice) => invoice.periodStart < to && invoice.periodEnd > from);
}

/** Each project already invoiced for some of `[from, to)`, with the invoice labels. */
function billedProjects(
  issued: IssuedInvoiceSummary[],
  from: string,
  to: string,
): Map<number, string[]> {
  const billed = new Map<number, string[]>();
  for (const invoice of overlapping(issued, from, to)) {
    for (const projectId of invoice.projectIds) {
      billed.set(projectId, [...(billed.get(projectId) ?? []), invoice.label]);
    }
  }
  return billed;
}

/** `2026-08-01` -> `2026-09-01`. */
function endOf(start: string): string {
  return monthEndExclusive(monthOf(start));
}

/** Month starts from `from` through `through`, oldest first. */
function monthsBetween(from: string, through: string): string[] {
  const months: string[] = [];
  for (let cursor = monthOf(from); monthStart(cursor) <= through; cursor = shiftMonth(cursor, 1)) {
    months.push(monthStart(cursor));
  }
  return months;
}

/** Selection is per project per month, so work billed in one month can be
 * left out while the same project's other months go on the invoice. */
function pairKey(start: string, projectId: number): string {
  return `${start}|${projectId}`;
}

/** Checked, unchecked, or a dash when the boxes it stands for disagree. */
function tristate(keys: string[], selected: Set<string>): boolean | "mixed" {
  const on = keys.filter((key) => selected.has(key)).length;
  return on === 0 ? false : on === keys.length ? true : "mixed";
}

/** One project's candidates summed across months. */
function combine(candidates: InvoiceCandidate[]): InvoiceCandidate {
  return candidates.reduce((sum, candidate) => ({
    ...sum,
    minutes: sum.minutes + candidate.minutes,
    fixedCents: sum.fixedCents + candidate.fixedCents,
    fixedCount: sum.fixedCount + candidate.fixedCount,
  }));
}

/** A month, what is already billed in it, and what this run will bill. */
interface MonthPlan {
  start: string;
  billed: Map<number, string[]>;
  earlier: IssuedInvoiceSummary[];
  /** Every billable project with work that month. */
  billable: InvoiceCandidate[];
  included: InvoiceCandidate[];
}

interface Props {
  clients: Client[];
  settings: Settings;
  onClose: () => void;
  onOpenSettings: () => void;
  /** Invoices were issued, so each client's next number has moved. */
  onIssued: () => void;
}

export function InvoiceDialog({ clients, settings, onClose, onOpenSettings, onIssued }: Props) {
  const billable = clients.filter((client) => client.archivedAt === null);

  const [clientId, setClientId] = useState(billable[0] ? String(billable[0].id) : "");
  /** What this client has already been invoiced for. */
  const [issuedBefore, setIssuedBefore] = useState<IssuedInvoiceSummary[]>([]);

  const monthOptions: DropdownOption[] = useMemo(() => {
    const now = currentMonth();
    return Array.from({ length: MONTHS_OFFERED }, (_, index) => {
      const cursor = shiftMonth(now, -index);
      const start = monthStart(cursor);
      const invoiced = issuedBefore.some((invoice) => invoice.periodStart === start);
      // Grouped the way issued invoices are filed: by year, then quarter.
      const quarter = Math.floor((cursor.month - 1) / 3) + 1;
      return {
        value: start,
        label: `${monthLabel(cursor)}${invoiced ? " · invoiced" : ""}`,
        group: `${cursor.year} · Q${quarter}`,
      };
    });
  }, [issuedBefore]);

  // A range of months, one invoice each. From and through the same month is
  // the ordinary single invoice.
  const [periodStart, setPeriodStart] = useState(() => monthStart(currentMonth()));
  const [periodThrough, setPeriodThrough] = useState(periodStart);

  const months = useMemo(() => monthsBetween(periodStart, periodThrough), [periodStart, periodThrough]);
  const batch = months.length > 1;

  // Another client's invoices say nothing about this one's; drop them until
  // this client's arrive.
  useEffect(() => {
    setIssuedBefore([]);
  }, [clientId]);
  /** Picked `pairKey`s. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Candidates per month start, for every month in the range. */
  const [byMonth, setByMonth] = useState<Map<string, InvoiceCandidate[]> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedInvoice[] | null>(null);
  /** The invoice whose mail draft is being opened. */
  const [emailing, setEmailing] = useState<number | null>(null);
  /** Drafts opened, by invoice id. */
  const [sent, setSent] = useState<Map<number, EmailAction>>(new Map());

  const client = billable.find((candidate) => String(candidate.id) === clientId);
  const currency = client?.currency ?? DEFAULT_CURRENCY;

  const missingSetup = [
    settings[SETTING_SENDER_NAME] ? null : "your name",
    settings[SETTING_INVOICE_FOLDER] ? null : "an invoice folder",
  ].filter((item): item is string => item !== null);

  // Reload whenever the client or months change, preselecting everything
  // billable so the common case is one click.
  useEffect(() => {
    if (clientId === "") return;

    let current = true;
    setByMonth(null);
    setError(null);

    Promise.all([
      Promise.all(months.map((start) => invoiceCandidates(Number(clientId), start, endOf(start)))),
      invoicesIssued(Number(clientId)),
    ])
      .then(([found, issued]) => {
        if (!current) return;
        const loaded = new Map(months.map((start, index) => [start, found[index]]));
        setIssuedBefore(issued);
        setByMonth(loaded);
        // Work already on an invoice for its month starts unchecked, but can
        // still be picked: entries may have been added after it went out, or
        // the earlier invoice may be one to replace.
        const unbilled = new Set<string>();
        for (const [start, candidates] of loaded) {
          const billed = billedProjects(issued, start, endOf(start));
          for (const candidate of candidates) {
            if (isBillable(candidate) && !billed.has(candidate.projectId)) {
              unbilled.add(pairKey(start, candidate.projectId));
            }
          }
        }
        setSelected(unbilled);
      })
      .catch((caught) => {
        if (current) setError(caught);
      });

    return () => {
      current = false;
    };
  }, [clientId, months]);

  const plans: MonthPlan[] = months.map((start) => {
    const billable = (byMonth?.get(start) ?? []).filter(isBillable);
    return {
      start,
      billed: billedProjects(issuedBefore, start, endOf(start)),
      earlier: overlapping(issuedBefore, start, endOf(start)),
      billable,
      included: billable.filter((candidate) => selected.has(pairKey(start, candidate.projectId))),
    };
  });
  const toIssue = plans.filter((plan) => plan.included.length > 0);

  /** Every project with work in the range: its pairs, and what the picked ones come to. */
  const projects = useMemo(() => {
    const grouped = new Map<number, { all: InvoiceCandidate[]; keys: string[]; billedOn: string[] }>();
    for (const [start, candidates] of byMonth ?? []) {
      const billed = billedProjects(issuedBefore, start, endOf(start));
      for (const candidate of candidates) {
        const entry = grouped.get(candidate.projectId) ?? { all: [], keys: [], billedOn: [] };
        entry.all.push(candidate);
        entry.keys.push(pairKey(start, candidate.projectId));
        entry.billedOn.push(...(billed.get(candidate.projectId) ?? []));
        grouped.set(candidate.projectId, entry);
      }
    }
    return [...grouped.values()]
      .map(({ all, keys, billedOn }) => ({ all, keys, billedOn: [...new Set(billedOn)] }))
      .sort((a, b) => a.all[0].code.toLowerCase().localeCompare(b.all[0].code.toLowerCase()));
  }, [byMonth, issuedBefore]);

  function toggle(keys: string[], checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  const chosen = toIssue.flatMap((plan) => plan.included);
  const totalCents = chosen.reduce((sum, candidate) => sum + candidateCents(candidate), 0);
  const lineCount = chosen.reduce((sum, candidate) => sum + candidateLines(candidate), 0);
  const chosenMinutes = chosen.reduce((sum, candidate) => sum + candidate.minutes, 0);

  /** The label each month will print, assuming the sequence has no taken gaps ahead. */
  function predictedLabel(index: number): string {
    return invoiceLabel(client?.code ?? null, (client?.nextInvoiceNumber ?? 1) + index);
  }

  const singleEarlier = batch ? [] : plans[0]?.earlier ?? [];

  async function sendEmail(invoiceId: number) {
    setEmailing(invoiceId);
    setError(null);
    try {
      const action = await invoiceEmail(invoiceId);
      setSent((previous) => new Map(previous).set(invoiceId, action));

      // Nothing was attached, so open the prefilled message and put the file
      // somewhere it can be dragged from.
      if (action.mailto !== null) {
        await openUrl(action.mailto);
        await revealItemInDir(action.filePath).catch(() => {});
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setEmailing(null);
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const drafts = await invoicePrepareMany(
        Number(clientId),
        toIssue.map((plan) => ({
          from: plan.start,
          to: endOf(plan.start),
          projectIds: plan.included.map((candidate) => candidate.projectId),
        })),
      );
      // Rendered here, then handed to Rust to write: the number in each
      // document and the number in its record are the same value.
      const pdfs = drafts.map(renderInvoicePdf);
      setIssued(await invoiceIssueMany(drafts, pdfs));
      onIssued();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  /** A single month stays a single month; a range keeps its end unless overtaken. */
  function changeStart(start: string) {
    // Radix's hidden form select can report "" when its options change under
    // it; no option has an empty value, so that is never a real choice.
    if (start === "") return;
    setPeriodStart(start);
    if (periodThrough === periodStart || periodThrough < start) setPeriodThrough(start);
  }

  if (issued !== null && issued.length === 1) {
    const [only] = issued;
    const action = sent.get(only.id);
    return (
      <Modal
        title={`Invoice ${only.label} saved`}
        submitLabel={emailing !== null ? "Opening mail…" : "Email to contacts"}
        onSubmit={() => void sendEmail(only.id)}
        secondaryLabel="Show in Finder"
        onSecondary={() => void revealItemInDir(only.filePath).catch(() => {})}
        onClose={onClose}
        canSubmit={emailing === null}
        busy={emailing !== null}
      >
        <p className="ledger-sub" style={{ wordBreak: "break-all" }}>
          {only.filePath}
        </p>

        {/* A successful draft speaks for itself — the mail app is now in front.
            Only the case where the file could not be attached needs saying,
            since otherwise an invoice would be sent without it. */}
        {action !== undefined && !action.attached && <UnattachedNote />}

        <ErrorNote error={error} />
      </Modal>
    );
  }

  if (issued !== null) {
    const unattached = [...sent.values()].some((action) => !action.attached);
    return (
      <Modal
        title={`${issued.length} invoices saved`}
        submitLabel="Done"
        onSubmit={onClose}
        secondaryLabel="Show in Finder"
        onSecondary={() => void revealItemInDir(issued[0].filePath).catch(() => {})}
        onClose={onClose}
        busy={emailing !== null}
      >
        <div className="ledger">
          {issued.map((invoice) => (
            <div key={invoice.id} className="ledger-row">
              <div className="ledger-main">
                <span className="ledger-code">{invoice.label}</span>
                <span className="ledger-name">{monthLabel(monthOf(invoice.periodStart))}</span>
                <span className="ledger-sub num">{formatMoney(invoice.totalCents, invoice.currency)}</span>
              </div>
              <div className="ledger-actions">
                <Button
                  variant="quiet"
                  onClick={() => void sendEmail(invoice.id)}
                  disabled={emailing !== null}
                >
                  {emailing === invoice.id ? "Opening…" : sent.has(invoice.id) ? "Emailed" : "Email"}
                </Button>
              </div>
            </div>
          ))}
        </div>

        {unattached && <UnattachedNote />}

        <ErrorNote error={error} />
      </Modal>
    );
  }

  if (missingSetup.length > 0) {
    return (
      <Modal
        title="Set up invoicing"
        submitLabel="Open settings"
        onSubmit={onOpenSettings}
        onClose={onClose}
      >
        <Empty title={`Add ${missingSetup.join(" and ")} first.`}>
          <p>An invoice needs a name to come from and a folder to be written to.</p>
        </Empty>
      </Modal>
    );
  }

  if (billable.length === 0) {
    return (
      <Modal title="New invoice" submitLabel="Open settings" onSubmit={onOpenSettings} onClose={onClose}>
        <Empty title="No clients yet">
          <p>Invoices are addressed to a client.</p>
        </Empty>
      </Modal>
    );
  }

  const submitLabel = busy
    ? "Generating…"
    : toIssue.length > 1
      ? `Generate ${toIssue.length} invoices`
      : "Generate invoice";

  return (
    <Modal
      title={batch ? "New invoices" : "New invoice"}
      submitLabel={submitLabel}
      onSubmit={() => void generate()}
      onClose={onClose}
      canSubmit={toIssue.length > 0 && !busy}
      busy={busy}
    >
      <DropdownField
        label="Client"
        inline
        value={clientId}
        onChange={setClientId}
        options={billable.map((client) => ({ value: String(client.id), label: client.name }))}
      />

      {/* One invoice per month. Through a later month generates several at
          once, numbered in order from the earliest. */}
      <SplitField label="Months">
        <Dropdown ariaLabel="From month" value={periodStart} onChange={changeStart} options={monthOptions} />
        <span className="split-sep">→</span>
        <Dropdown
          ariaLabel="Through month"
          value={periodThrough}
          onChange={(through) => through !== "" && setPeriodThrough(through)}
          options={monthOptions.filter((option) => option.value >= periodStart)}
        />
      </SplitField>

      {singleEarlier.map((invoice) => (
        <div key={invoice.id} className="invoice-existing" role="status">
          <span>
            Invoice {invoice.label} already covers this month: issued{" "}
            {dayLabel(invoice.issueDate)} {invoice.issueDate.slice(0, 4)},{" "}
            {formatMoney(invoice.totalCents, invoice.currency)}. Its projects start unchecked.
          </span>
          <Button variant="quiet" onClick={() => void revealItemInDir(invoice.filePath).catch(() => {})}>
            Show
          </Button>
        </div>
      ))}

      <div className="field">
        <span>Projects</span>
        {byMonth === null ? (
          <p className="loading">Looking for tracked time…</p>
        ) : projects.length === 0 ? (
          <p className="loading">
            Nothing logged for this client {batch ? "in those months" : "that month"}.
          </p>
        ) : (
          <div className="ledger">
            {projects.map(({ all, keys, billedOn }) => {
              const unbillable = !all.some(isBillable);
              const picked = all.filter((_, index) => selected.has(keys[index]));
              // What the ticked months come to, or all of them when none are.
              const shown = combine(picked.length > 0 ? picked : all);
              return (
                <CheckRow
                  key={shown.projectId}
                  checked={unbillable ? false : tristate(keys, selected)}
                  disabled={unbillable}
                  onChange={(checked) => toggle(keys, checked)}
                >
                  <span className="ledger-name">
                    <span className="ledger-code">{shown.code}</span> {shown.name}
                  </span>
                  <span className="num">
                    {unbillable ? "no rate" : candidateSummary(shown, currency)}
                    {/* Across months, the month rows say which are invoiced. */}
                    {!batch && billedOn.length > 0 && ` · on ${billedOn.join(", ")}`}
                  </span>
                </CheckRow>
              );
            })}
          </div>
        )}
      </div>

      {batch && byMonth !== null && projects.length > 0 && (
        <div className="field">
          <span>Invoices</span>
          <div className="ledger">
            {plans.map((plan) => {
              const index = toIssue.indexOf(plan);
              const cents = plan.included.reduce((sum, candidate) => sum + candidateCents(candidate), 0);
              const keys = plan.billable.map((candidate) => pairKey(plan.start, candidate.projectId));
              const earlier = plan.earlier.map((invoice) => invoice.label).join(", ");
              return (
                <CheckRow
                  key={plan.start}
                  checked={keys.length === 0 ? false : tristate(keys, selected)}
                  disabled={keys.length === 0}
                  onChange={(checked) => toggle(keys, checked)}
                >
                  <span className="ledger-name">
                    <span className="ledger-code">{index >= 0 ? predictedLabel(index) : "—"}</span>{" "}
                    {monthLabel(monthOf(plan.start))}
                  </span>
                  <span className="num">
                    {keys.length === 0
                      ? "nothing to bill"
                      : index >= 0
                        ? formatMoney(cents, currency)
                        : "skipped"}
                    {earlier !== "" && ` · on ${earlier}`}
                  </span>
                </CheckRow>
              );
            })}
          </div>
        </div>
      )}

      {chosen.length > 0 && (
        <div className="invoice-total">
          <span className="eyebrow">
            {batch
              ? `${toIssue.length} ${toIssue.length === 1 ? "invoice" : "invoices"}`
              : `${predictedLabel(0)} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
            {chosenMinutes > 0 && ` · ${formatMinutes(chosenMinutes)}`}
          </span>
          <span className="figure-value is-earned">{formatMoney(totalCents, currency)}</span>
        </div>
      )}

      <ErrorNote error={error} />
    </Modal>
  );
}

function UnattachedNote() {
  return (
    <p className="error">
      Your mail app cannot be sent an attachment. The invoice is revealed in Finder — drag it into
      the message.
    </p>
  );
}
