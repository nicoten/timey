//! Database access. Nothing in this module knows about Tauri, so every query
//! below is exercisable from a plain `cargo test`.

pub mod clients;
pub mod contacts;
pub mod entries;
pub mod projects;

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::error::AppResult;

/// The handle passed to every query function and held in Tauri's managed state.
pub type Db = sqlx::SqlitePool;

/// Open (creating if needed) the database at `path`, then bring the schema up to
/// date. Migrations are embedded in the binary, so a fresh install needs no
/// external files.
pub async fn connect(path: &Path) -> AppResult<Db> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        // SQLite defaults foreign keys OFF per connection. Every ON DELETE rule
        // in the schema depends on this line.
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    migrate(&pool).await?;
    Ok(pool)
}

/// A private in-memory database for tests. Capped at one connection because an
/// in-memory SQLite database belongs to its connection — a second one would see
/// an empty schema.
pub async fn connect_in_memory() -> AppResult<Db> {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
        .connect_with(options)
        .await?;

    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(pool: &Db) -> AppResult<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}
