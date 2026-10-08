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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** Candidates per month start, for every month in the range. */
  const [byMonth, setByMonth] = useState<Map<string, InvoiceCandidate[]> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedInvoice[] | null>(null);
  /** The invoice whose mail draft is being opened. */
  const [emailing, setEmailing] = useState<number | null>(null);
  /** Drafts opened, by invoice id. */
  const [sent, setSent] = useState<Map<number, EmailAction>>(new Map());
  /** Asking before a second invoice for a period that already has one. */
  const [confirmingRepeat, setConfirmingRepeat] = useState(false);

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
        // Work already on an invoice for its month starts unchecked. A single
        // month can still be picked, for entries added after that invoice went
        // out; across several months, billed months are always left out.
        const unbilled = new Set<number>();
        for (const [start, candidates] of loaded) {
          const billed = billedProjects(issued, start, endOf(start));
          for (const candidate of candidates) {
            if (isBillable(candidate) && !billed.has(candidate.projectId)) {
              unbilled.add(candidate.projectId);
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
    const billed = billedProjects(issuedBefore, start, endOf(start));
    const included = (byMonth?.get(start) ?? []).filter(
      (candidate) =>
        selected.has(candidate.projectId) &&
        isBillable(candidate) &&
        (!batch || !billed.has(candidate.projectId)),
    );
    return { start, billed, earlier: overlapping(issuedBefore, start, endOf(start)), included };
  });
  const toIssue = plans.filter((plan) => plan.included.length > 0);

  /** Every project with work in the range, summed over the months it would bill. */
  const projects = useMemo(() => {
    const grouped = new Map<number, { all: InvoiceCandidate[]; billable: InvoiceCandidate[] }>();
    for (const [start, candidates] of byMonth ?? []) {
      const billed = billedProjects(issuedBefore, start, endOf(start));
      for (const candidate of candidates) {
        const entry = grouped.get(candidate.projectId) ?? { all: [], billable: [] };
        entry.all.push(candidate);
        if (!batch || !billed.has(candidate.projectId)) entry.billable.push(candidate);
        grouped.set(candidate.projectId, entry);
      }
    }
    return [...grouped.values()]
      .map(({ all, billable }) => ({
        candidate: combine(billable.length > 0 ? billable : all),
        alreadyBilled: billable.length === 0,
      }))
      .sort((a, b) => a.candidate.code.toLowerCase().localeCompare(b.candidate.code.toLowerCase()));
  }, [byMonth, issuedBefore, batch]);

  const chosen = toIssue.flatMap((plan) => plan.included);
  const totalCents = chosen.reduce((sum, candidate) => sum + candidateCents(candidate), 0);
  const lineCount = chosen.reduce((sum, candidate) => sum + candidateLines(candidate), 0);
  const chosenMinutes = chosen.reduce((sum, candidate) => sum + candidate.minutes, 0);

  /** The label each month will print, assuming the sequence has no taken gaps ahead. */
  function predictedLabel(index: number): string {
    return invoiceLabel(client?.code ?? null, (client?.nextInvoiceNumber ?? 1) + index);
  }

  const singleEarlier = batch ? [] : plans[0]?.earlier ?? [];
  const singleBilled = batch ? new Map<number, string[]>() : plans[0]?.billed ?? new Map();

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
      setConfirmingRepeat(false);
      onIssued();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  function changeStart(start: string) {
    setPeriodStart(start);
    if (periodThrough < start) setPeriodThrough(start);
  }

  if (confirmingRepeat) {
    const labels = singleEarlier.map((invoice) => invoice.label).join(" and ");
    return (
      <Modal
        title="Invoice this month again?"
        submitLabel={busy ? "Generating…" : "Generate anyway"}
        onSubmit={() => void generate()}
        secondaryLabel="Go back"
        onSecondary={() => setConfirmingRepeat(false)}
        onClose={onClose}
        canSubmit={!busy}
        busy={busy}
      >
        <p className="invoice-warning" role="alert">
          {monthLabel(monthOf(periodStart))} is already covered by invoice {labels}. A new invoice
          takes the next number and bills every entry of the selected projects in that month,
          including any already on an earlier invoice.
        </p>
        <ErrorNote error={error} />
      </Modal>
    );
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
      onSubmit={() => (singleEarlier.length > 0 ? setConfirmingRepeat(true) : void generate())}
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
          onChange={setPeriodThrough}
          options={monthOptions.filter((option) => option.value >= periodStart)}
        />
      </SplitField>

      {singleEarlier.map((invoice) => (
        <div key={invoice.id} className="invoice-existing" role="status">
          <span>
            Invoice {invoice.label} already covers this period: issued{" "}
            {dayLabel(invoice.issueDate)} {invoice.issueDate.slice(0, 4)},{" "}
            {formatMoney(invoice.totalCents, invoice.currency)}.
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
            {projects.map(({ candidate, alreadyBilled }) => {
              const unbillable = !isBillable(candidate);
              return (
                <CheckRow
                  key={candidate.projectId}
                  checked={selected.has(candidate.projectId) && !alreadyBilled}
                  disabled={unbillable || alreadyBilled}
                  onChange={(checked) =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (checked) next.add(candidate.projectId);
                      else next.delete(candidate.projectId);
                      return next;
                    })
                  }
                >
                  <span className="ledger-name">
                    <span className="ledger-code">{candidate.code}</span> {candidate.name}
                  </span>
                  <span className="num">
                    {unbillable
                      ? "no rate"
                      : alreadyBilled
                        ? "already invoiced"
                        : candidateSummary(candidate, currency)}
                    {singleBilled.has(candidate.projectId) &&
                      ` · on invoice ${singleBilled.get(candidate.projectId)!.join(", ")}`}
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
              const skippedBilled = plan.earlier.length > 0;
              return (
                <div key={plan.start} className="ledger-row">
                  <div className="ledger-main">
                    <span className="ledger-code">{index >= 0 ? predictedLabel(index) : "—"}</span>
                    <span className="ledger-name">{monthLabel(monthOf(plan.start))}</span>
                  </div>
                  <span className="ledger-sub num">
                    {index >= 0
                      ? formatMoney(cents, currency)
                      : skippedBilled
                        ? `on ${plan.earlier.map((invoice) => invoice.label).join(", ")}`
                        : "nothing to bill"}
                  </span>
                </div>
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
