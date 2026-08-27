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
    pub duration_minutes: i64,
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
    pub minutes: i64,
    /// `None` means the project has no rate, so it cannot be billed.
    pub hourly_rate_cents: Option<i64>,
}

/// One line of an invoice, as it will be printed and stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLine {
    pub project_id: i64,
    pub description: String,
    pub minutes: i64,
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

/// Where an issued invoice ended up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedInvoice {
    pub id: i64,
    pub number: i64,
    pub file_path: String,
}
