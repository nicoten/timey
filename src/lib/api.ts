/**
 * Typed wrappers over the Rust commands in `src-tauri/src/commands/mod.rs`.
 *
 * Nothing else in the frontend should call `invoke` directly: keeping it here
 * means the argument names and shapes are stated once. Tauri converts command
 * arguments to camelCase by default, which is what these wrappers pass.
 */

import { invoke } from "@tauri-apps/api/core";

// --- row types (mirror src-tauri/src/model.rs) -----------------------------

export interface Client {
  id: number;
  name: string;
  /** Employer identification number, printed on invoices. */
  ein: string | null;
  /** One freeform block, newline-separated, reproduced verbatim on invoices. */
  address: string | null;
  /** ISO 4217 code: what every amount for this client is in. */
  currency: string;
  /** UTC instant; non-null means archived. */
  archivedAt: string | null;
  createdAt: string;
}

export interface Contact {
  id: number;
  clientId: number;
  name: string;
  email: string;
  createdAt: string;
}

export interface Project {
  id: number;
  clientId: number;
  /** Short handle, unique across all live projects. */
  code: string;
  name: string;
  color: string | null;
  /** Integer cents, never a float. */
  hourlyRateCents: number | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface Entry {
  id: number;
  projectId: number;
  name: string;
  /** Local wall-clock, `YYYY-MM-DDTHH:MM`, on the 15-minute grid. */
  startedAt: string;
  /** Zero for a fixed-price entry. */
  durationMinutes: number;
  /** Integer cents. Non-null means a fixed-price entry, billed at this amount. */
  amountCents: number | null;
  createdAt: string;
  updatedAt: string;
}

/** An entry joined to its project and client, with the end time derived. */
export interface EntryDetail {
  id: number;
  projectId: number;
  name: string;
  startedAt: string;
  durationMinutes: number;
  /** `startedAt + durationMinutes`, computed by the database on read. */
  endedAt: string;
  projectCode: string;
  projectName: string;
  clientId: number;
  clientName: string;
  /** The client's currency, which the entry's money is in. */
  currency: string;
  /** Non-null means a fixed-price entry; see `Entry.amountCents`. */
  amountCents: number | null;
  /** The project's rate at read time, for computing what the entry earned. */
  hourlyRateCents: number | null;
}

export interface DailyTotal {
  /** `YYYY-MM-DD`. */
  day: string;
  minutes: number;
}

// --- errors ----------------------------------------------------------------

export type ErrorKind = "validation" | "notFound" | "conflict" | "database" | "io";

/** The shape a rejected command throws. */
export interface AppError {
  kind: ErrorKind;
  message: string;
}

/** Narrows an unknown caught value to an `AppError`. */
export function isAppError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "message" in error &&
    typeof (error as AppError).message === "string"
  );
}

/** A message safe to show someone, whatever was thrown. */
export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// --- duration helpers ------------------------------------------------------

/** The grid every duration and start time lands on, matching the schema. */
export const DURATION_STEP_MINUTES = 15;

/** `90` -> `"1h 30m"`, `60` -> `"1h"`, `45` -> `"45m"`. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

// --- clients ---------------------------------------------------------------

export function clientsList(includeArchived = false): Promise<Client[]> {
  return invoke("clients_list", { includeArchived });
}

export function clientCreate(input: {
  name: string;
  ein?: string | null;
  address?: string | null;
  currency: string;
}): Promise<Client> {
  return invoke("client_create", {
    name: input.name,
    ein: input.ein ?? null,
    address: input.address ?? null,
    currency: input.currency,
  });
}

export function clientUpdate(input: {
  id: number;
  name: string;
  ein?: string | null;
  address?: string | null;
  currency: string;
}): Promise<Client> {
  return invoke("client_update", {
    id: input.id,
    name: input.name,
    ein: input.ein ?? null,
    address: input.address ?? null,
    currency: input.currency,
  });
}

export function clientSetArchived(id: number, archived: boolean): Promise<Client> {
  return invoke("client_set_archived", { id, archived });
}

/** Fails while the client still has projects. */
export function clientDelete(id: number): Promise<void> {
  return invoke("client_delete", { id });
}

// --- contacts --------------------------------------------------------------

export function contactsList(clientId: number): Promise<Contact[]> {
  return invoke("contacts_list", { clientId });
}

export function contactCreate(clientId: number, name: string, email: string): Promise<Contact> {
  return invoke("contact_create", { clientId, name, email });
}

export function contactUpdate(id: number, name: string, email: string): Promise<Contact> {
  return invoke("contact_update", { id, name, email });
}

export function contactDelete(id: number): Promise<void> {
  return invoke("contact_delete", { id });
}

// --- projects --------------------------------------------------------------

export function projectsList(
  clientId: number | null = null,
  includeArchived = false,
): Promise<Project[]> {
  return invoke("projects_list", { clientId, includeArchived });
}

export function projectCreate(input: {
  clientId: number;
  code: string;
  name: string;
  color?: string | null;
  hourlyRateCents?: number | null;
}): Promise<Project> {
  return invoke("project_create", {
    clientId: input.clientId,
    code: input.code,
    name: input.name,
    color: input.color ?? null,
    hourlyRateCents: input.hourlyRateCents ?? null,
  });
}

export function projectUpdate(input: {
  id: number;
  code: string;
  name: string;
  color?: string | null;
  hourlyRateCents?: number | null;
}): Promise<Project> {
  return invoke("project_update", {
    id: input.id,
    code: input.code,
    name: input.name,
    color: input.color ?? null,
    hourlyRateCents: input.hourlyRateCents ?? null,
  });
}

export function projectSetArchived(id: number, archived: boolean): Promise<Project> {
  return invoke("project_set_archived", { id, archived });
}

/** Fails while the project still holds entries — archive it instead. */
export function projectDelete(id: number): Promise<void> {
  return invoke("project_delete", { id });
}

// --- entries ---------------------------------------------------------------

/**
 * Entries starting in `[from, to)`. Both bounds accept `YYYY-MM-DD` or a full
 * `YYYY-MM-DDTHH:MM`.
 */
export function entriesList(
  from: string,
  to: string,
  projectId: number | null = null,
): Promise<EntryDetail[]> {
  return invoke("entries_list", { from, to, projectId });
}

export function entryCreate(input: {
  projectId: number;
  name: string;
  startedAt: string;
  durationMinutes: number;
}): Promise<Entry> {
  return invoke("entry_create", input);
}

/** A full replacement, including moving the entry to a different project. */
export function entryUpdate(input: {
  id: number;
  projectId: number;
  name: string;
  startedAt: string;
  durationMinutes: number;
}): Promise<Entry> {
  return invoke("entry_update", input);
}

/** A fixed-price entry: a day and an amount, no time. */
export function entryCreateFixed(input: {
  projectId: number;
  name: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
}): Promise<Entry> {
  return invoke("entry_create_fixed", input);
}

/** Replaces an entry with a fixed-price one, whichever kind it was. */
export function entryUpdateFixed(input: {
  id: number;
  projectId: number;
  name: string;
  date: string;
  amountCents: number;
}): Promise<Entry> {
  return invoke("entry_update_fixed", input);
}

export function entryDelete(id: number): Promise<void> {
  return invoke("entry_delete", { id });
}

export async function entriesDailyTotals(from: string, to: string): Promise<DailyTotal[]> {
  const rows = await invoke<[string, number][]>("entries_daily_totals", { from, to });
  return rows.map(([day, minutes]) => ({ day, minutes }));
}

// --- settings --------------------------------------------------------------

/** Keys the Rust side knows about. */
export const SETTING_INVOICE_FOLDER = "invoice_folder";
export const SETTING_SENDER_NAME = "sender_name";

export type Settings = Record<string, string>;

export function settingsAll(): Promise<Settings> {
  return invoke("settings_all");
}

/** An empty value removes the setting. */
export function settingsSet(key: string, value: string): Promise<void> {
  return invoke("settings_set", { key, value });
}

// --- invoicing -------------------------------------------------------------

export interface InvoiceCandidate {
  projectId: number;
  code: string;
  name: string;
  /** Timed minutes only; fixed-price entries contribute none. */
  minutes: number;
  /** `null` means the project has no rate, so its timed minutes cannot be billed. */
  hourlyRateCents: number | null;
  /** The fixed-price entries in the period: their sum, and how many lines they add. */
  fixedCents: number;
  fixedCount: number;
}

export interface InvoiceLine {
  projectId: number;
  description: string;
  /** `null` for a fixed-price line: a quantity of one at `rateCents`. */
  minutes: number | null;
  rateCents: number;
  amountCents: number;
}

export interface InvoiceDraft {
  number: number;
  issueDate: string;
  client: Client;
  senderName: string;
  periodStart: string;
  /** Exclusive, matching how entries are queried. */
  periodEnd: string;
  /** The last day actually billed, which is what the document shows. */
  periodEndInclusive: string;
  lines: InvoiceLine[];
  totalCents: number;
  fileName: string;
}

export interface IssuedInvoice {
  id: number;
  number: number;
  filePath: string;
}

export function invoiceCandidates(
  clientId: number,
  from: string,
  to: string,
): Promise<InvoiceCandidate[]> {
  return invoke("invoice_candidates", { clientId, from, to });
}

/** An invoice already issued, for warning against billing the same work twice. */
export interface IssuedInvoiceSummary {
  id: number;
  number: number;
  issueDate: string;
  /** Inclusive start of the billing period. */
  periodStart: string;
  /** Exclusive end. */
  periodEnd: string;
  totalCents: number;
  currency: string;
  filePath: string;
  /** The projects it has lines for. */
  projectIds: number[];
}

/** Every invoice issued to this client, latest period first. */
export function invoicesIssued(clientId: number): Promise<IssuedInvoiceSummary[]> {
  return invoke("invoices_issued", { clientId });
}

export function invoicePrepare(
  clientId: number,
  projectIds: number[],
  from: string,
  to: string,
): Promise<InvoiceDraft> {
  return invoke("invoice_prepare", { clientId, projectIds, from, to });
}

/** Writes the rendered PDF and records the invoice. */
export function invoiceIssue(draft: InvoiceDraft, pdf: Uint8Array): Promise<IssuedInvoice> {
  // Tauri deserializes a plain number array into Rust's Vec<u8>.
  return invoke("invoice_issue", { draft, pdf: Array.from(pdf) });
}

/** `1050` -> `"17.50"`, the quantity column on an invoice. */
export function hoursDecimal(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

export interface EmailAction {
  /** True when a draft opened with the PDF already attached. */
  attached: boolean;
  recipients: string[];
  /** Present only when the caller must open it, the PDF being unattached. */
  mailto: string | null;
  filePath: string;
}

/** Opens a mail draft for an issued invoice, addressed to the client's contacts. */
export function invoiceEmail(invoiceId: number): Promise<EmailAction> {
  return invoke("invoice_email", { invoiceId });
}

// --- importing -------------------------------------------------------------

/** A spreadsheet read for import, before anything is stored. */
export interface ImportPreview {
  sheetName: string;
  /** The header text of each column used. */
  columns: {
    date: string;
    description: string | null;
    amount: string;
    currency: string | null;
  };
  rows: ImportRow[];
  /** Rows with an amount of zero or less, left out as money going out. */
  skippedOutgoing: number;
}

/** One incoming payment found in the spreadsheet. */
export interface ImportRow {
  /** 1-based, as the spreadsheet numbers it. */
  sourceRow: number;
  /** `YYYY-MM-DD`. */
  date: string;
  /** The sheet's own text, which may be empty. */
  description: string;
  amountCents: number;
  /** As the sheet writes it, upper-cased. */
  currency: string | null;
}

/** A reviewed row, to be stored as a fixed-price entry. */
export interface FixedEntryInput {
  projectId: number;
  name: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
}

export function importRead(path: string): Promise<ImportPreview> {
  return invoke("import_read", { path });
}

/** For each row, whether a matching fixed-price entry already exists. */
export function importDuplicates(rows: FixedEntryInput[]): Promise<boolean[]> {
  return invoke("import_duplicates", { rows });
}

/** Stores every row as a fixed-price entry, or none of them. */
export function importCommit(rows: FixedEntryInput[]): Promise<Entry[]> {
  return invoke("import_commit", { rows });
}

// --- window ----------------------------------------------------------------

/** Resizes the popover in points, keeping it hanging from the menu bar icon. */
export function popoverResize(width: number, height: number): Promise<void> {
  return invoke("popover_resize", { width, height });
}
