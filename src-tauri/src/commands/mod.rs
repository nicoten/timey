//! Tauri command wrappers.
//!
//! These are intentionally thin: they unwrap managed state and delegate. All
//! rules live in `db` and `validate`, so the same behaviour is reachable from
//! tests without a running app.

use tauri::State;

use crate::db::{self, Db};
use crate::error::AppResult;
use crate::model::{Client, Contact, Entry, EntryDetail, Project};

#[tauri::command]
pub async fn clients_list(db: State<'_, Db>, include_archived: bool) -> AppResult<Vec<Client>> {
    db::clients::list(&db, include_archived).await
}

#[tauri::command]
pub async fn client_create(db: State<'_, Db>, name: String) -> AppResult<Client> {
    db::clients::create(&db, &name).await
}

#[tauri::command]
pub async fn client_rename(db: State<'_, Db>, id: i64, name: String) -> AppResult<Client> {
    db::clients::rename(&db, id, &name).await
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
