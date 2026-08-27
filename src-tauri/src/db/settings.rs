//! A key/value settings store.
//!
//! Settings that shape documents on disk — where invoices are written, the name
//! they are signed with — belong in the database next to the data, not in the
//! frontend's local storage, which is per-machine and easily cleared.

use std::collections::HashMap;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::validate;

/// Absolute path of the folder invoices are written to.
pub const INVOICE_FOLDER: &str = "invoice_folder";
/// The name that appears after "From" on an invoice.
pub const SENDER_NAME: &str = "sender_name";

pub async fn all(db: &Db) -> AppResult<HashMap<String, String>> {
    let rows = sqlx::query!(r#"SELECT key AS "key!", value AS "value!" FROM settings"#)
        .fetch_all(db)
        .await?;

    Ok(rows.into_iter().map(|row| (row.key, row.value)).collect())
}

pub async fn get(db: &Db, key: &str) -> AppResult<Option<String>> {
    let row = sqlx::query!(r#"SELECT value AS "value!" FROM settings WHERE key = ?1"#, key)
        .fetch_optional(db)
        .await?;

    Ok(row.map(|row| row.value))
}

/// Stores a trimmed value, or removes the key when given nothing.
pub async fn set(db: &Db, key: &str, value: &str) -> AppResult<()> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        sqlx::query!("DELETE FROM settings WHERE key = ?1", key)
            .execute(db)
            .await?;
        return Ok(());
    }

    sqlx::query!(
        r#"
        INSERT INTO settings (key, value) VALUES (?1, ?2)
        ON CONFLICT (key) DO UPDATE
        SET value = excluded.value,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        "#,
        key,
        trimmed
    )
    .execute(db)
    .await?;

    Ok(())
}

/// Fetches a setting that must be present, with a message naming what to do.
pub async fn require(db: &Db, key: &str, what: &str) -> AppResult<String> {
    get(db, key).await?.ok_or_else(|| {
        AppError::validation(format!("Set {what} in Settings before issuing an invoice."))
    })
}

/// Today's date in the machine's own timezone, as `YYYY-MM-DD`.
///
/// Local rather than UTC: an invoice is dated the day you issued it where you
/// are, which is the same wall-clock reasoning entries use.
pub async fn today_local(db: &Db) -> AppResult<String> {
    let row = sqlx::query!(
        r#"SELECT strftime('%Y-%m-%d', 'now', 'localtime') AS "today!: String""#
    )
    .fetch_one(db)
    .await?;

    validate::date_bound("today", &row.today)
}
