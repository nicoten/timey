//! Tauri command wrappers.
//!
//! These are intentionally thin: they unwrap managed state and delegate. All
//! rules live in `db` and `validate`, so the same behaviour is reachable from
//! tests without a running app.

use std::collections::HashMap;

use tauri::State;

use crate::db::{self, Db};
use crate::mail::{self, EmailAction};
use crate::error::AppResult;
use crate::import;
use crate::model::{
    Client, Contact, Entry, EntryDetail, FixedEntryInput, ImportPreview, InvoiceCandidate,
    InvoiceDraft, IssuedInvoice, IssuedInvoiceSummary, Project,
};

#[tauri::command]
pub async fn clients_list(db: State<'_, Db>, include_archived: bool) -> AppResult<Vec<Client>> {
    db::clients::list(&db, include_archived).await
}

#[tauri::command]
pub async fn client_create(
    db: State<'_, Db>,
    name: String,
    ein: Option<String>,
    address: Option<String>,
    currency: String,
) -> AppResult<Client> {
    db::clients::create(&db, &name, ein, address, &currency).await
}

#[tauri::command]
pub async fn client_update(
    db: State<'_, Db>,
    id: i64,
    name: String,
    ein: Option<String>,
    address: Option<String>,
    currency: String,
) -> AppResult<Client> {
    db::clients::update(&db, id, &name, ein, address, &currency).await
}

#[tauri::command]
pub async fn client_set_archived(db: State<'_, Db>, id: i64, archived: bool) -> AppResult<Client> {
    db::clients::set_archived(&db, id, archived).await
}

#[tauri::command]
pub async fn client_delete(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db::clients::delete(&db, id).await
}

#[tauri::command]
pub async fn contacts_list(db: State<'_, Db>, client_id: i64) -> AppResult<Vec<Contact>> {
    db::contacts::list_for_client(&db, client_id).await
}

#[tauri::command]
pub async fn contact_create(
    db: State<'_, Db>,
    client_id: i64,
    name: String,
    email: String,
) -> AppResult<Contact> {
    db::contacts::create(&db, client_id, &name, &email).await
}

#[tauri::command]
pub async fn contact_update(
    db: State<'_, Db>,
    id: i64,
    name: String,
    email: String,
) -> AppResult<Contact> {
    db::contacts::update(&db, id, &name, &email).await
}

#[tauri::command]
pub async fn contact_delete(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db::contacts::delete(&db, id).await
}

#[tauri::command]
pub async fn projects_list(
    db: State<'_, Db>,
    client_id: Option<i64>,
    include_archived: bool,
) -> AppResult<Vec<Project>> {
    db::projects::list(&db, client_id, include_archived).await
}

#[tauri::command]
pub async fn project_create(
    db: State<'_, Db>,
    client_id: i64,
    code: String,
    name: String,
    color: Option<String>,
    hourly_rate_cents: Option<i64>,
) -> AppResult<Project> {
    db::projects::create(&db, client_id, &code, &name, color, hourly_rate_cents).await
}

#[tauri::command]
pub async fn project_update(
    db: State<'_, Db>,
    id: i64,
    code: String,
    name: String,
    color: Option<String>,
    hourly_rate_cents: Option<i64>,
) -> AppResult<Project> {
    db::projects::update(&db, id, &code, &name, color, hourly_rate_cents).await
}

#[tauri::command]
pub async fn project_set_archived(
    db: State<'_, Db>,
    id: i64,
    archived: bool,
) -> AppResult<Project> {
    db::projects::set_archived(&db, id, archived).await
}

#[tauri::command]
pub async fn project_delete(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db::projects::delete(&db, id).await
}

#[tauri::command]
pub async fn entries_list(
    db: State<'_, Db>,
    from: String,
    to: String,
    project_id: Option<i64>,
) -> AppResult<Vec<EntryDetail>> {
    db::entries::list_in_range(&db, &from, &to, project_id).await
}

#[tauri::command]
pub async fn entry_create(
    db: State<'_, Db>,
    project_id: i64,
    name: String,
    started_at: String,
    duration_minutes: i64,
) -> AppResult<Entry> {
    db::entries::create(&db, project_id, &name, &started_at, duration_minutes).await
}

#[tauri::command]
pub async fn entry_update(
    db: State<'_, Db>,
    id: i64,
    project_id: i64,
    name: String,
    started_at: String,
    duration_minutes: i64,
) -> AppResult<Entry> {
    db::entries::update(&db, id, project_id, &name, &started_at, duration_minutes).await
}

/// A fixed-price entry: a day and an amount, no time.
#[tauri::command]
pub async fn entry_create_fixed(
    db: State<'_, Db>,
    project_id: i64,
    name: String,
    date: String,
    amount_cents: i64,
) -> AppResult<Entry> {
    db::entries::create_fixed(&db, project_id, &name, &date, amount_cents).await
}

/// Replaces an entry with a fixed-price one, whichever kind it was.
#[tauri::command]
pub async fn entry_update_fixed(
    db: State<'_, Db>,
    id: i64,
    project_id: i64,
    name: String,
    date: String,
    amount_cents: i64,
) -> AppResult<Entry> {
    db::entries::update_fixed(&db, id, project_id, &name, &date, amount_cents).await
}

#[tauri::command]
pub async fn entry_delete(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db::entries::delete(&db, id).await
}

/// Minutes per calendar day, as `[day, minutes]` pairs.
#[tauri::command]
pub async fn entries_daily_totals(
    db: State<'_, Db>,
    from: String,
    to: String,
) -> AppResult<Vec<(String, i64)>> {
    db::entries::daily_totals(&db, &from, &to).await
}

// --- settings --------------------------------------------------------------

#[tauri::command]
pub async fn settings_all(db: State<'_, Db>) -> AppResult<HashMap<String, String>> {
    db::settings::all(&db).await
}

/// An empty value removes the setting.
#[tauri::command]
pub async fn settings_set(db: State<'_, Db>, key: String, value: String) -> AppResult<()> {
    db::settings::set(&db, &key, &value).await
}

// --- invoicing -------------------------------------------------------------

/// Projects of this client with time logged in `[from, to)`.
#[tauri::command]
pub async fn invoice_candidates(
    db: State<'_, Db>,
    client_id: i64,
    from: String,
    to: String,
) -> AppResult<Vec<InvoiceCandidate>> {
    db::invoices::candidates(&db, client_id, &from, &to).await
}

/// Invoices already issued to this client, so the same work is not billed twice.
#[tauri::command]
pub async fn invoices_issued(db: State<'_, Db>, client_id: i64) -> AppResult<Vec<IssuedInvoiceSummary>> {
    db::invoices::issued_for_client(&db, client_id).await
}

/// Everything needed to render the document, including the number it will take.
#[tauri::command]
pub async fn invoice_prepare(
    db: State<'_, Db>,
    client_id: i64,
    project_ids: Vec<i64>,
    from: String,
    to: String,
) -> AppResult<InvoiceDraft> {
    db::invoices::prepare(&db, client_id, &project_ids, &from, &to).await
}

/// Records the invoice and writes the rendered PDF to the configured folder.
#[tauri::command]
pub async fn invoice_issue(
    db: State<'_, Db>,
    draft: InvoiceDraft,
    pdf: Vec<u8>,
) -> AppResult<IssuedInvoice> {
    db::invoices::issue(&db, &draft, &pdf).await
}

/// Opens a mail draft for an issued invoice, addressed to the client's contacts.
///
/// Attaches the PDF when Apple Mail is the default; otherwise the returned
/// `mailto` is what the caller should open, the file being unattached.
#[tauri::command]
pub async fn invoice_email(db: State<'_, Db>, invoice_id: i64) -> AppResult<EmailAction> {
    let plan = db::invoices::email_plan(&db, invoice_id).await?;

    mail::compose(
        plan.number,
        &plan.sender_name,
        &plan.period_start,
        &plan.file_path,
        plan.recipients,
    )
}

// --- importing -------------------------------------------------------------

/// Reads the first sheet of a spreadsheet and finds the payments in it.
#[tauri::command]
pub async fn import_read(path: String) -> AppResult<ImportPreview> {
    // calamine reads synchronously; keep it off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || import::read_xlsx(std::path::Path::new(&path)))
        .await
        .map_err(|err| crate::error::AppError::Io(err.to_string()))?
}

/// For each row, whether it has already been imported.
#[tauri::command]
pub async fn import_duplicates(db: State<'_, Db>, rows: Vec<FixedEntryInput>) -> AppResult<Vec<bool>> {
    db::entries::fixed_exist(&db, &rows).await
}

/// Stores the reviewed rows as fixed-price entries, all or none.
#[tauri::command]
pub async fn import_commit(db: State<'_, Db>, rows: Vec<FixedEntryInput>) -> AppResult<Vec<Entry>> {
    db::entries::create_fixed_many(&db, &rows).await
}

// --- window ----------------------------------------------------------------

/// Resizes the popover in logical points, keeping it centred where it was and
/// its top edge in place, so it still hangs from the menu bar icon.
#[tauri::command]
pub fn popover_resize(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    crate::resize_popover(&window, width, height).map_err(|err| err.to_string())
}
