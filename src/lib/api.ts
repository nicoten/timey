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
  durationMinutes: number;
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

/** Allowed durations, 15 minutes to 12 hours — the dropdown's options. */
export const DURATION_STEP_MINUTES = 15;
export const DURATION_OPTIONS: number[] = Array.from(
  { length: (12 * 60) / DURATION_STEP_MINUTES },
  (_, index) => (index + 1) * DURATION_STEP_MINUTES,
);

/** `90` -> `"1h 30m"`, `60` -> `"1h"`, `45` -> `"45m"`. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

/** Start times available on a given day, matching the schema's 15-minute grid. */
export function startTimeOptions(): string[] {
  const options: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += DURATION_STEP_MINUTES) {
      options.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  return options;
}

// --- clients ---------------------------------------------------------------

export function clientsList(includeArchived = false): Promise<Client[]> {
  return invoke("clients_list", { includeArchived });
}

export function clientCreate(input: {
  name: string;
  ein?: string | null;
  address?: string | null;
}): Promise<Client> {
  return invoke("client_create", {
    name: input.name,
    ein: input.ein ?? null,
    address: input.address ?? null,
  });
}

export function clientUpdate(input: {
  id: number;
  name: string;
  ein?: string | null;
  address?: string | null;
}): Promise<Client> {
  return invoke("client_update", {
    id: input.id,
    name: input.name,
    ein: input.ein ?? null,
    address: input.address ?? null,
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
  minutes: number;
  /** `null` means the project has no rate, so it cannot be billed. */
  hourlyRateCents: number | null;
}

export interface InvoiceLine {
  projectId: number;
  description: string;
  minutes: number;
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
