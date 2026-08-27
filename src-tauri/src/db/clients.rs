use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::model::Client;
use crate::validate;

/// Shared projection, so `get` and the read-back after an update cannot drift.
///
/// Updates deliberately do not use `UPDATE ... RETURNING`: sqlx's SQLite driver
/// decodes a NULL from an UPDATE's RETURNING clause as `Some("")` rather than
/// `None`, which silently corrupts nullable fields such as `archived_at`. Write
/// then read inside one transaction instead.
async fn by_id<'e, E>(executor: E, id: i64) -> AppResult<Option<Client>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let client = sqlx::query_as!(
        Client,
        r#"
        SELECT id AS "id!", name, ein, address, archived_at, created_at
        FROM clients WHERE id = ?1
        "#,
        id
    )
    .fetch_optional(executor)
    .await?;

    Ok(client)
}

pub async fn list(db: &Db, include_archived: bool) -> AppResult<Vec<Client>> {
    let clients = sqlx::query_as!(
        Client,
        r#"
        SELECT id AS "id!", name, ein, address, archived_at, created_at
        FROM clients
        WHERE ?1 OR archived_at IS NULL
        ORDER BY lower(name)
        "#,
        include_archived
    )
    .fetch_all(db)
    .await?;

    Ok(clients)
}

pub async fn get(db: &Db, id: i64) -> AppResult<Client> {
    by_id(db, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Client", id })
}

pub async fn create(
    db: &Db,
    name: &str,
    ein: Option<String>,
    address: Option<String>,
) -> AppResult<Client> {
    let name = validate::non_empty("Client name", name)?;
    let ein = validate::optional_text(ein);
    let address = validate::optional_text(address);

    let client = sqlx::query_as!(
        Client,
        r#"
        INSERT INTO clients (name, ein, address) VALUES (?1, ?2, ?3)
        RETURNING id AS "id!", name, ein, address, archived_at, created_at
        "#,
        name,
        ein,
        address
    )
    .fetch_one(db)
    .await?;

    Ok(client)
}

pub async fn update(
    db: &Db,
    id: i64,
    name: &str,
    ein: Option<String>,
    address: Option<String>,
) -> AppResult<Client> {
    let name = validate::non_empty("Client name", name)?;
    let ein = validate::optional_text(ein);
    let address = validate::optional_text(address);

    let mut tx = db.begin().await?;

    let affected = sqlx::query!(
        "UPDATE clients SET name = ?2, ein = ?3, address = ?4 WHERE id = ?1",
        id,
        name,
        ein,
        address
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Client", id });
    }

    let client = by_id(&mut *tx, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Client", id })?;

    tx.commit().await?;
    Ok(client)
}

/// Archiving hides a client without touching its history, and frees its name.
pub async fn set_archived(db: &Db, id: i64, archived: bool) -> AppResult<Client> {
    let mut tx = db.begin().await?;

    let affected = sqlx::query!(
        r#"
        UPDATE clients
        SET archived_at = CASE
            WHEN ?2 THEN coalesce(archived_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            ELSE NULL
        END
        WHERE id = ?1
        "#,
        id,
        archived
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Client", id });
    }

    let client = by_id(&mut *tx, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Client", id })?;

    tx.commit().await?;
    Ok(client)
}

/// Fails while the client still has projects; its contacts are removed with it.
pub async fn delete(db: &Db, id: i64) -> AppResult<()> {
    let affected = sqlx::query!("DELETE FROM clients WHERE id = ?1", id)
        .execute(db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Client", id });
    }
    Ok(())
}
