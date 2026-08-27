import { useEffect, useMemo, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import {
  SETTING_INVOICE_FOLDER,
  SETTING_SENDER_NAME,
  hoursDecimal,
  invoiceCandidates,
  invoiceEmail,
  invoiceIssue,
  invoicePrepare,
  type Client,
  type InvoiceCandidate,
  type EmailAction,
  type IssuedInvoice,
  type Settings,
} from "../lib/api";
import { currentMonth, monthEndExclusive, monthLabel, monthStart, shiftMonth } from "../lib/dates";
import { renderInvoicePdf } from "../lib/invoicePdf";
import { formatMinutes, formatMoney } from "../lib/money";
import {
  CheckRow,
  DropdownField,
  Empty,
  ErrorNote,
  Modal,
  type DropdownOption,
} from "./ui";

/** How far back the month picker offers. */
const MONTHS_OFFERED = 18;

interface Props {
  clients: Client[];
  settings: Settings;
  onClose: () => void;
  onOpenSettings: () => void;
}

export function InvoiceDialog({ clients, settings, onClose, onOpenSettings }: Props) {
  const billable = clients.filter((client) => client.archivedAt === null);

  const monthOptions: DropdownOption[] = useMemo(() => {
    const now = currentMonth();
    return Array.from({ length: MONTHS_OFFERED }, (_, index) => {
      const cursor = shiftMonth(now, -index);
      return { value: monthStart(cursor), label: monthLabel(cursor) };
    });
  }, []);

  const [clientId, setClientId] = useState(billable[0] ? String(billable[0].id) : "");
  const [periodStart, setPeriodStart] = useState(monthOptions[0].value);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [candidates, setCandidates] = useState<InvoiceCandidate[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedInvoice | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [sent, setSent] = useState<EmailAction | null>(null);

  const periodEnd = useMemo(() => {
    const [year, month] = periodStart.split("-").map(Number);
    return monthEndExclusive({ year, month });
  }, [periodStart]);

  const missingSetup = [
    settings[SETTING_SENDER_NAME] ? null : "your name",
    settings[SETTING_INVOICE_FOLDER] ? null : "an invoice folder",
  ].filter((item): item is string => item !== null);

  // Reload whenever the client or month changes, preselecting everything
  // billable so the common case is one click.
  useEffect(() => {
    if (clientId === "") return;

    let current = true;
    setCandidates(null);
    setError(null);

    invoiceCandidates(Number(clientId), periodStart, periodEnd)
      .then((found) => {
        if (!current) return;
        setCandidates(found);
        setSelected(
          new Set(
            found
              .filter((candidate) => candidate.hourlyRateCents !== null)
              .map((candidate) => candidate.projectId),
          ),
        );
      })
      .catch((caught) => {
        if (current) setError(caught);
      });

    return () => {
      current = false;
    };
  }, [clientId, periodStart, periodEnd]);

  const chosen = (candidates ?? []).filter((candidate) => selected.has(candidate.projectId));
  const totalCents = chosen.reduce(
    (sum, candidate) =>
      sum + Math.round(((candidate.hourlyRateCents ?? 0) * candidate.minutes) / 60),
    0,
  );

  async function sendEmail(invoiceId: number) {
    setEmailing(true);
    setError(null);
    try {
      const action = await invoiceEmail(invoiceId);
      setSent(action);

      // Nothing was attached, so open the prefilled message and put the file
      // somewhere it can be dragged from.
      if (action.mailto !== null) {
        await openUrl(action.mailto);
        await revealItemInDir(action.filePath).catch(() => {});
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setEmailing(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const draft = await invoicePrepare(
        Number(clientId),
        [...selected],
        periodStart,
        periodEnd,
      );
      // Rendered here, then handed to Rust to write: the number in the document
      // and the number in the record are the same value.
      const pdf = renderInvoicePdf(draft);
      setIssued(await invoiceIssue(draft, pdf));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (issued !== null) {
    return (
      <Modal
        title={`Invoice ${issued.number} saved`}
        submitLabel={emailing ? "Opening mail…" : "Email to contacts"}
        onSubmit={() => void sendEmail(issued.id)}
        secondaryLabel="Show in Finder"
        onSecondary={() => void revealItemInDir(issued.filePath).catch(() => {})}
        onClose={onClose}
        canSubmit={!emailing}
        busy={emailing}
      >
        <p className="ledger-sub" style={{ wordBreak: "break-all" }}>
          {issued.filePath}
        </p>

        {/* A successful draft speaks for itself — the mail app is now in front.
            Only the case where the file could not be attached needs saying,
            since otherwise an invoice would be sent without it. */}
        {sent !== null && !sent.attached && (
          <p className="error">
            Your mail app cannot be sent an attachment. The invoice is revealed in
            Finder — drag it into the message.
          </p>
        )}

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

  return (
    <Modal
      title="New invoice"
      submitLabel={busy ? "Generating…" : "Generate invoice"}
      onSubmit={() => void generate()}
      onClose={onClose}
      canSubmit={selected.size > 0 && !busy}
      busy={busy}
    >
      <DropdownField
        label="Client"
        inline
        value={clientId}
        onChange={setClientId}
        options={billable.map((client) => ({ value: String(client.id), label: client.name }))}
      />

      <DropdownField
        label="Month"
        inline
        value={periodStart}
        onChange={setPeriodStart}
        options={monthOptions}
      />

      <div className="field">
        <span>Projects</span>
        {candidates === null ? (
          <p className="loading">Looking for tracked time…</p>
        ) : candidates.length === 0 ? (
          <p className="loading">No time logged for this client that month.</p>
        ) : (
          <div className="ledger">
            {candidates.map((candidate) => {
              const unbillable = candidate.hourlyRateCents === null;
              return (
                <CheckRow
                  key={candidate.projectId}
                  checked={selected.has(candidate.projectId)}
                  disabled={unbillable}
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
                      : `${hoursDecimal(candidate.minutes)}h · ${formatMoney(
                          Math.round(
                            ((candidate.hourlyRateCents ?? 0) * candidate.minutes) / 60,
                          ),
                        )}`}
                  </span>
                </CheckRow>
              );
            })}
          </div>
        )}
      </div>

      {chosen.length > 0 && (
        <div className="invoice-total">
          <span className="eyebrow">
            {chosen.length} {chosen.length === 1 ? "line" : "lines"} ·{" "}
            {formatMinutes(chosen.reduce((sum, item) => sum + item.minutes, 0))}
          </span>
          <span className="figure-value is-earned">{formatMoney(totalCents)}</span>
        </div>
      )}

      <ErrorNote error={error} />
    </Modal>
  );
}
