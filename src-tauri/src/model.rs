//! Row types shared by the database layer, the commands, and (via camelCase
//! serialization) the TypeScript wrappers in `src/lib/api.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub id: i64,
    pub name: String,
    /// Employer identification number, printed on invoices.
    pub ein: Option<String>,
    /// One freeform block, newline-separated, reproduced verbatim on invoices.
    pub address: Option<String>,
    /// ISO 4217 code: what every amount for this client is in.
    pub currency: String,
    /// UTC instant, `Z`-suffixed. Non-null means archived.
    pub archived_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: i64,
    pub client_id: i64,
    pub name: String,
    pub email: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub client_id: i64,
    /// Short handle, unique across all live projects.
    pub code: String,
    pub name: String,
    pub color: Option<String>,
    /// Integer cents, never a float.
    pub hourly_rate_cents: Option<i64>,
    pub archived_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    /// Local wall-clock, `YYYY-MM-DDTHH:MM`, on the 15-minute grid.
    pub started_at: String,
    /// Zero for a fixed-price entry.
    pub duration_minutes: i64,
    /// Integer cents. Present means a fixed-price entry, billed at this amount
    /// rather than by the hour.
    pub amount_cents: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// An entry joined to its project and client, with the end time derived rather
/// than stored. This is what list views actually need.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetail {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub started_at: String,
    pub duration_minutes: i64,
    /// `started_at + duration_minutes`, computed on read.
    pub ended_at: String,
    pub project_code: String,
    pub project_name: String,
    pub client_id: i64,
    pub client_name: String,
    /// The client's currency, which the entry's money is in.
    pub currency: String,
    /// Present means a fixed-price entry; see `Entry::amount_cents`.
    pub amount_cents: Option<i64>,
    /// The project's rate at read time, for computing what the entry earned.
    pub hourly_rate_cents: Option<i64>,
}

// --- invoicing --------------------------------------------------------------

/// A project with billable time in a period, offered for inclusion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceCandidate {
    pub project_id: i64,
    pub code: String,
    pub name: String,
    /// Timed minutes only; fixed-price entries contribute none.
    pub minutes: i64,
    /// `None` means the project has no rate, so its timed minutes cannot be billed.
    pub hourly_rate_cents: Option<i64>,
    /// The fixed-price entries in the period: their sum, and how many lines
    /// they will add.
    pub fixed_cents: i64,
    pub fixed_count: i64,
}

/// One line of an invoice, as it will be printed and stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLine {
    pub project_id: i64,
    pub description: String,
    /// `None` for a fixed-price line, which bills a quantity of one at
    /// `rate_cents`.
    pub minutes: Option<i64>,
    pub rate_cents: i64,
    pub amount_cents: i64,
}

/// Everything needed to render an invoice, before it is issued.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceDraft {
    pub number: i64,
    pub issue_date: String,
    pub client: Client,
    pub sender_name: String,
    /// Inclusive start of the billing period.
    pub period_start: String,
    /// Exclusive end, matching how entries are queried.
    pub period_end: String,
    /// The last day actually billed, which is what the document shows.
    pub period_end_inclusive: String,
    pub lines: Vec<InvoiceLine>,
    pub total_cents: i64,
    pub file_name: String,
}

/// An invoice already issued, as the invoice dialog needs it to warn against
/// billing the same work twice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedInvoiceSummary {
    pub id: i64,
    pub number: i64,
    pub issue_date: String,
    /// Inclusive start of the billing period.
    pub period_start: String,
    /// Exclusive end.
    pub period_end: String,
    pub total_cents: i64,
    pub currency: String,
    pub file_path: String,
    /// The projects it has lines for, still existing.
    pub project_ids: Vec<i64>,
}

/// Where an issued invoice ended up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedInvoice {
    pub id: i64,
    pub number: i64,
    pub file_path: String,
}

// --- importing --------------------------------------------------------------

/// A spreadsheet read for import, before anything is stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub sheet_name: String,
    pub columns: ImportColumns,
    pub rows: Vec<ImportRow>,
    /// Rows with a date but an amount of zero or less: money going out.
    pub skipped_outgoing: i64,
}

/// The header text of each column used, so the person can see what was picked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumns {
    pub date: String,
    pub description: Option<String>,
    pub amount: String,
    pub currency: Option<String>,
}

/// One incoming payment found in the spreadsheet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    /// 1-based, as the spreadsheet numbers it.
    pub source_row: i64,
    /// `YYYY-MM-DD`.
    pub date: String,
    /// The sheet's own text, which may be empty.
    pub description: String,
    pub amount_cents: i64,
    /// As the sheet writes it, upper-cased.
    pub currency: Option<String>,
}

/// A reviewed row, to be stored as a fixed-price entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedEntryInput {
    pub project_id: i64,
    pub name: String,
    /// `YYYY-MM-DD`.
    pub date: String,
    pub amount_cents: i64,
}
