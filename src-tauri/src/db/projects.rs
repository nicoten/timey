use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::model::Project;
use crate::validate;

/// See the note in `clients::by_id`: updates write then read rather than using
/// `UPDATE ... RETURNING`, which mis-decodes NULLs.
async fn by_id<'e, E>(executor: E, id: i64) -> AppResult<Option<Project>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let project = sqlx::query_as!(
        Project,
        r#"
        SELECT id AS "id!", client_id, code, name, color, hourly_rate_cents,
               archived_at, created_at
        FROM projects WHERE id = ?1
        "#,
        id
    )
    .fetch_optional(executor)
    .await?;

    Ok(project)
}

/// `client_id` filters to one client when given; `include_archived` widens the
/// result to archived rows.
pub async fn list(
    db: &Db,
    client_id: Option<i64>,
    include_archived: bool,
) -> AppResult<Vec<Project>> {
    let projects = sqlx::query_as!(
        Project,
        r#"
        SELECT id AS "id!", client_id, code, name, color, hourly_rate_cents,
               archived_at, created_at
        FROM projects
        WHERE (?1 IS NULL OR client_id = ?1)
          AND (?2 OR archived_at IS NULL)
        ORDER BY lower(code)
        "#,
        client_id,
        include_archived
    )
    .fetch_all(db)
    .await?;

    Ok(projects)
}

pub async fn get(db: &Db, id: i64) -> AppResult<Project> {
    by_id(db, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Project", id })
}

pub async fn create(
    db: &Db,
    client_id: i64,
    code: &str,
    name: &str,
    color: Option<String>,
    hourly_rate_cents: Option<i64>,
) -> AppResult<Project> {
    let code = validate::non_empty("Project code", code)?;
    let name = validate::non_empty("Project name", name)?;
    let color = validate::optional_color(color)?;
    let hourly_rate_cents = validate::optional_rate_cents(hourly_rate_cents)?;

    let project = sqlx::query_as!(
        Project,
        r#"
        INSERT INTO projects (client_id, code, name, color, hourly_rate_cents)
        VALUES (?1, ?2, ?3, ?4, ?5)
        RETURNING id AS "id!", client_id, code, name, color, hourly_rate_cents,
                  archived_at, created_at
        "#,
        client_id,
        code,
        name,
        color,
        hourly_rate_cents
    )
    .fetch_one(db)
    .await?;

    Ok(project)
}

pub async fn update(
    db: &Db,
    id: i64,
    code: &str,
    name: &str,
    color: Option<String>,
    hourly_rate_cents: Option<i64>,
) -> AppResult<Project> {
    let code = validate::non_empty("Project code", code)?;
    let name = validate::non_empty("Project name", name)?;
    let color = validate::optional_color(color)?;
    let hourly_rate_cents = validate::optional_rate_cents(hourly_rate_cents)?;

    let mut tx = db.begin().await?;

    let affected = sqlx::query!(
        r#"
        UPDATE projects
        SET code = ?2, name = ?3, color = ?4, hourly_rate_cents = ?5
        WHERE id = ?1
        "#,
        id,
        code,
        name,
        color,
        hourly_rate_cents
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Project", id });
    }

    let project = by_id(&mut *tx, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Project", id })?;

    tx.commit().await?;
    Ok(project)
}

pub async fn set_archived(db: &Db, id: i64, archived: bool) -> AppResult<Project> {
    let mut tx = db.begin().await?;

    let affected = sqlx::query!(
        r#"
        UPDATE projects
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
        return Err(AppError::NotFound { entity: "Project", id });
    }

    let project = by_id(&mut *tx, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Project", id })?;

    tx.commit().await?;
    Ok(project)
}

/// Fails while the project still holds entries — archive it instead.
pub async fn delete(db: &Db, id: i64) -> AppResult<()> {
    let affected = sqlx::query!("DELETE FROM projects WHERE id = ?1", id)
        .execute(db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Project", id });
    }
    Ok(())
}
