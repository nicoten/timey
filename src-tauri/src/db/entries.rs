use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::model::{Entry, EntryDetail};
use crate::validate;

/// Entries whose start falls in `[from, to)`, joined to project and client.
///
/// Because `started_at` is stored as `YYYY-MM-DDTHH:MM`, the bounds sort
/// lexically — a plain `2026-08-27` works as a bound with no conversion.
pub async fn list_in_range(
    db: &Db,
    from: &str,
    to: &str,
    project_id: Option<i64>,
) -> AppResult<Vec<EntryDetail>> {
    let from = validate::date_bound("from", from)?;
    let to = validate::date_bound("to", to)?;

    let entries = sqlx::query_as!(
        EntryDetail,
        r#"
        SELECT e.id                AS "id!",
               e.project_id        AS "project_id!",
               e.name              AS "name!",
               e.started_at        AS "started_at!",
               e.duration_minutes  AS "duration_minutes!",
               strftime('%Y-%m-%dT%H:%M', e.started_at,
                        '+' || e.duration_minutes || ' minutes') AS "ended_at!: String",
               p.code              AS "project_code!",
               p.name              AS "project_name!",
               c.id                AS "client_id!",
               c.name              AS "client_name!"
        FROM entries e
        JOIN projects p ON p.id = e.project_id
        JOIN clients  c ON c.id = p.client_id
        WHERE e.started_at >= ?1
          AND e.started_at <  ?2
          AND (?3 IS NULL OR e.project_id = ?3)
        ORDER BY e.started_at, e.id
        "#,
        from,
        to,
        project_id
    )
    .fetch_all(db)
    .await?;

    Ok(entries)
}

/// See the note in `clients::by_id`: updates write then read back rather than
/// relying on `UPDATE ... RETURNING`.
async fn by_id<'e, E>(executor: E, id: i64) -> AppResult<Option<Entry>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let entry = sqlx::query_as!(
        Entry,
        r#"
        SELECT id AS "id!", project_id, name, started_at, duration_minutes,
               created_at, updated_at
        FROM entries WHERE id = ?1
        "#,
        id
    )
    .fetch_optional(executor)
    .await?;

    Ok(entry)
}

pub async fn get(db: &Db, id: i64) -> AppResult<Entry> {
    by_id(db, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Entry", id })
}

pub async fn create(
    db: &Db,
    project_id: i64,
    name: &str,
    started_at: &str,
    duration_minutes: i64,
) -> AppResult<Entry> {
    let name = validate::non_empty("Entry name", name)?;
    let started_at = validate::started_at(started_at)?;
    let duration_minutes = validate::duration_minutes(duration_minutes)?;

    let entry = sqlx::query_as!(
        Entry,
        r#"
        INSERT INTO entries (project_id, name, started_at, duration_minutes)
        VALUES (?1, ?2, ?3, ?4)
        RETURNING id AS "id!", project_id, name, started_at, duration_minutes,
                  created_at, updated_at
        "#,
        project_id,
        name,
        started_at,
        duration_minutes
    )
    .fetch_one(db)
    .await?;

    Ok(entry)
}

/// A full replacement, including moving the entry to a different project.
pub async fn update(
    db: &Db,
    id: i64,
    project_id: i64,
    name: &str,
    started_at: &str,
    duration_minutes: i64,
) -> AppResult<Entry> {
    let name = validate::non_empty("Entry name", name)?;
    let started_at = validate::started_at(started_at)?;
    let duration_minutes = validate::duration_minutes(duration_minutes)?;

    let mut tx = db.begin().await?;

    let affected = sqlx::query!(
        r#"
        UPDATE entries
        SET project_id = ?2,
            name = ?3,
            started_at = ?4,
            duration_minutes = ?5,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?1
        "#,
        id,
        project_id,
        name,
        started_at,
        duration_minutes
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Entry", id });
    }

    let entry = by_id(&mut *tx, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Entry", id })?;

    tx.commit().await?;
    Ok(entry)
}

pub async fn delete(db: &Db, id: i64) -> AppResult<()> {
    let affected = sqlx::query!("DELETE FROM entries WHERE id = ?1", id)
        .execute(db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Entry", id });
    }
    Ok(())
}

/// Minutes tracked per calendar day in `[from, to)`, for reporting.
pub async fn daily_totals(db: &Db, from: &str, to: &str) -> AppResult<Vec<(String, i64)>> {
    let from = validate::date_bound("from", from)?;
    let to = validate::date_bound("to", to)?;

    let rows = sqlx::query!(
        r#"
        SELECT substr(started_at, 1, 10) AS "day!: String",
               CAST(sum(duration_minutes) AS INTEGER) AS "minutes!: i64"
        FROM entries
        WHERE started_at >= ?1 AND started_at < ?2
        GROUP BY substr(started_at, 1, 10)
        ORDER BY substr(started_at, 1, 10)
        "#,
        from,
        to
    )
    .fetch_all(db)
    .await?;

    Ok(rows.into_iter().map(|row| (row.day, row.minutes)).collect())
}
