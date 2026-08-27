use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::model::Contact;
use crate::validate;

/// See the note in `clients::by_id`: updates write then read back rather than
/// relying on `UPDATE ... RETURNING`.
async fn by_id<'e, E>(executor: E, id: i64) -> AppResult<Option<Contact>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let contact = sqlx::query_as!(
        Contact,
        r#"
        SELECT id AS "id!", client_id, name, email, created_at
        FROM contacts WHERE id = ?1
        "#,
        id
    )
    .fetch_optional(executor)
    .await?;

    Ok(contact)
}

pub async fn list_for_client(db: &Db, client_id: i64) -> AppResult<Vec<Contact>> {
    let contacts = sqlx::query_as!(
        Contact,
        r#"
        SELECT id AS "id!", client_id, name, email, created_at
        FROM contacts
        WHERE client_id = ?1
        ORDER BY lower(name)
        "#,
        client_id
    )
    .fetch_all(db)
    .await?;

    Ok(contacts)
}

pub async fn create(db: &Db, client_id: i64, name: &str, email: &str) -> AppResult<Contact> {
    let name = validate::non_empty("Contact name", name)?;
    let email = validate::email(email)?;

    let contact = sqlx::query_as!(
        Contact,
        r#"
        INSERT INTO contacts (client_id, name, email) VALUES (?1, ?2, ?3)
        RETURNING id AS "id!", client_id, name, email, created_at
        "#,
        client_id,
        name,
        email
    )
    .fetch_one(db)
    .await?;

    Ok(contact)
}

pub async fn update(db: &Db, id: i64, name: &str, email: &str) -> AppResult<Contact> {
    let name = validate::non_empty("Contact name", name)?;
    let email = validate::email(email)?;

    let mut tx = db.begin().await?;

    let affected = sqlx::query!(
        "UPDATE contacts SET name = ?2, email = ?3 WHERE id = ?1",
        id,
        name,
        email
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Contact", id });
    }

    let contact = by_id(&mut *tx, id)
        .await?
        .ok_or(AppError::NotFound { entity: "Contact", id })?;

    tx.commit().await?;
    Ok(contact)
}

pub async fn delete(db: &Db, id: i64) -> AppResult<()> {
    let affected = sqlx::query!("DELETE FROM contacts WHERE id = ?1", id)
        .execute(db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound { entity: "Contact", id });
    }
    Ok(())
}
