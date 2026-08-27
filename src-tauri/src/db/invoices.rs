//! Invoice preparation and issuing.
//!
//! An invoice is computed from entries once, then stored line by line. It is a
//! document that has been sent to someone: re-deriving it later from live
//! projects would let a rate change rewrite history.

use std::path::{Path, PathBuf};

use crate::db::{settings, Db};
use crate::error::{AppError, AppResult};
use crate::model::{InvoiceCandidate, InvoiceDraft, InvoiceLine, IssuedInvoice};
use crate::validate;

/// What one line earns, rounded to the cent.
///
/// Computed from the line's whole minute total rather than by summing rounded
/// per-entry amounts, so `quantity × unit price` on the page equals the amount
/// beside it — the arithmetic the person reading the invoice will check.
pub fn line_amount_cents(rate_cents: i64, minutes: i64) -> i64 {
    (rate_cents * minutes + 30) / 60
}

/// `2026-08-01` -> `08/01/2026`.
fn us_date(date: &str) -> String {
    format!("{}/{}/{}", &date[5..7], &date[8..10], &date[0..4])
}

/// Lowercased, punctuation collapsed to single dashes, for use in a filename.
fn slug(value: &str) -> String {
    let mut out = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Every project of this client with billable minutes in `[from, to)`.
///
/// Projects without a rate are included so the picker can show why they cannot
/// be billed, rather than silently omitting time that was tracked.
pub async fn candidates(
    db: &Db,
    client_id: i64,
    from: &str,
    to: &str,
) -> AppResult<Vec<InvoiceCandidate>> {
    let from = validate::date_bound("from", from)?;
    let to = validate::date_bound("to", to)?;

    let rows = sqlx::query!(
        r#"
        SELECT p.id                AS "project_id!",
               p.code              AS "code!",
               p.name              AS "name!",
               CAST(sum(e.duration_minutes) AS INTEGER) AS "minutes!: i64",
               p.hourly_rate_cents AS "hourly_rate_cents"
        FROM entries e
        JOIN projects p ON p.id = e.project_id
        WHERE p.client_id = ?1
          AND e.started_at >= ?2
          AND e.started_at <  ?3
        GROUP BY p.id
        ORDER BY lower(p.code)
        "#,
        client_id,
        from,
        to
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| InvoiceCandidate {
            project_id: row.project_id,
            code: row.code,
            name: row.name,
            minutes: row.minutes,
            hourly_rate_cents: row.hourly_rate_cents,
        })
        .collect())
}

/// Builds an invoice without issuing it: the number is the one it would take.
pub async fn prepare(
    db: &Db,
    client_id: i64,
    project_ids: &[i64],
    from: &str,
    to: &str,
) -> AppResult<InvoiceDraft> {
    if project_ids.is_empty() {
        return Err(AppError::validation("Pick at least one project to invoice."));
    }

    let client = crate::db::clients::get(db, client_id).await?;
    let sender_name = settings::require(db, settings::SENDER_NAME, "your name").await?;
    // Checked now rather than after rendering, so the failure arrives early.
    settings::require(db, settings::INVOICE_FOLDER, "an invoice folder").await?;

    let period_start = validate::date_bound("from", from)?;
    let period_end = validate::date_bound("to", to)?;
    let period_end_inclusive = validate::previous_day(&period_end)?;

    let available = candidates(db, client_id, &period_start, &period_end).await?;
    let mut lines = Vec::new();

    for candidate in available {
        if !project_ids.contains(&candidate.project_id) {
            continue;
        }

        let rate_cents = candidate.hourly_rate_cents.ok_or_else(|| {
            AppError::validation(format!(
                "{} has no hourly rate, so it cannot be invoiced. Add one in Settings.",
                candidate.code
            ))
        })?;

        lines.push(InvoiceLine {
            project_id: candidate.project_id,
            description: format!(
                "[{}] {} ({} - {})",
                candidate.code,
                candidate.name,
                us_date(&period_start),
                us_date(&period_end_inclusive)
            ),
            minutes: candidate.minutes,
            rate_cents,
            amount_cents: line_amount_cents(rate_cents, candidate.minutes),
        });
    }

    if lines.is_empty() {
        return Err(AppError::validation(
            "No time was logged against those projects in that period.",
        ));
    }

    let total_cents = lines.iter().map(|line| line.amount_cents).sum();
    let number = next_number(db).await?;
    let issue_date = settings::today_local(db).await?;

    Ok(InvoiceDraft {
        file_name: format!(
            "invoice-{number:04}-{}-{}.pdf",
            slug(&client.name),
            &period_start[0..7]
        ),
        number,
        issue_date,
        client,
        sender_name,
        period_start,
        period_end,
        period_end_inclusive,
        lines,
        total_cents,
    })
}

/// Everything the mail draft needs for an already-issued invoice.
pub async fn email_plan(db: &Db, invoice_id: i64) -> AppResult<EmailPlan> {
    let invoice = sqlx::query!(
        r#"
        SELECT number       AS "number!: i64",
               client_id    AS "client_id!: i64",
               period_start AS "period_start!",
               file_path    AS "file_path!"
        FROM invoices WHERE id = ?1
        "#,
        invoice_id
    )
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound { entity: "Invoice", id: invoice_id })?;

    let sender_name = settings::require(db, settings::SENDER_NAME, "your name").await?;

    let recipients = sqlx::query!(
        r#"SELECT email AS "email!" FROM contacts WHERE client_id = ?1 ORDER BY lower(name)"#,
        invoice.client_id
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|row| row.email)
    .collect();

    Ok(EmailPlan {
        number: invoice.number,
        sender_name,
        period_start: invoice.period_start,
        file_path: invoice.file_path,
        recipients,
    })
}

/// The inputs to `mail::compose`, read back from a stored invoice.
pub struct EmailPlan {
    pub number: i64,
    pub sender_name: String,
    pub period_start: String,
    pub file_path: String,
    pub recipients: Vec<String>,
}

/// The next number in the sequence: one past the highest ever issued.
pub async fn next_number(db: &Db) -> AppResult<i64> {
    let row = sqlx::query!(
        r#"SELECT CAST(coalesce(max(number), 0) AS INTEGER) AS "highest!: i64" FROM invoices"#
    )
    .fetch_one(db)
    .await?;

    Ok(row.highest + 1)
}

/// Records the invoice and writes the rendered PDF.
///
/// The row goes in first and the file is written before the transaction commits,
/// so a failed write leaves neither a record without a document nor a number
/// quietly consumed.
pub async fn issue(db: &Db, draft: &InvoiceDraft, pdf: &[u8]) -> AppResult<IssuedInvoice> {
    if pdf.is_empty() {
        return Err(AppError::validation("The rendered invoice was empty."));
    }

    let folder = settings::require(db, settings::INVOICE_FOLDER, "an invoice folder").await?;
    let path = destination(&folder, &draft.file_name)?;
    let path_text = path.to_string_lossy().to_string();

    let mut tx = db.begin().await?;

    let invoice_id = sqlx::query!(
        r#"
        INSERT INTO invoices
            (number, client_id, issue_date, period_start, period_end, total_cents, file_path)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        draft.number,
        draft.client.id,
        draft.issue_date,
        draft.period_start,
        draft.period_end,
        draft.total_cents,
        path_text
    )
    .execute(&mut *tx)
    .await
    .map_err(|err| match &err {
        // The number is unique, so a collision means something else issued one
        // since this draft was prepared.
        sqlx::Error::Database(db_err) if db_err.message().contains("UNIQUE") => {
            AppError::Conflict(format!(
                "Invoice number {} already exists. Close this and start again to take the next number.",
                draft.number
            ))
        }
        _ => AppError::from_sqlx(err),
    })?
    .last_insert_rowid();

    for line in &draft.lines {
        sqlx::query!(
            r#"
            INSERT INTO invoice_lines
                (invoice_id, project_id, description, minutes, rate_cents, amount_cents)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            invoice_id,
            line.project_id,
            line.description,
            line.minutes,
            line.rate_cents,
            line.amount_cents
        )
        .execute(&mut *tx)
        .await?;
    }

    write_pdf(&path, pdf)?;
    tx.commit().await?;

    Ok(IssuedInvoice {
        id: invoice_id,
        number: draft.number,
        file_path: path_text,
    })
}

/// Rejects a filename that tries to escape the configured folder.
fn destination(folder: &str, file_name: &str) -> AppResult<PathBuf> {
    let trimmed = file_name.trim();

    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(AppError::validation(format!(
            "`{trimmed}` is not a usable invoice filename."
        )));
    }

    Ok(Path::new(folder).join(trimmed))
}

fn write_pdf(path: &Path, pdf: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, pdf)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_amount_matches_quantity_times_unit_price() {
        // The reference invoice: 17.5 hours at $155.00 comes to $2,712.50.
        assert_eq!(line_amount_cents(15_500, 17 * 60 + 30), 271_250);
    }

    #[test]
    fn line_amount_rounds_to_the_nearest_cent() {
        // 15 minutes at $133.33/h is $33.3325, which rounds up.
        assert_eq!(line_amount_cents(13_333, 15), 3_333);
        // A half cent rounds up rather than truncating.
        assert_eq!(line_amount_cents(2, 15), 1);
        assert_eq!(line_amount_cents(0, 600), 0);
    }

    #[test]
    fn dates_print_in_month_day_year() {
        assert_eq!(us_date("2026-08-01"), "08/01/2026");
        assert_eq!(us_date("2025-12-31"), "12/31/2025");
    }

    #[test]
    fn slugs_are_filename_safe() {
        assert_eq!(slug("Acme Industries"), "acme-industries");
        assert_eq!(slug("Northwind"), "northwind");
        assert_eq!(slug("Foo & Bar, Inc."), "foo-bar-inc");
        assert_eq!(slug("  spaced  out  "), "spaced-out");
    }

    #[test]
    fn destination_rejects_paths_that_escape_the_folder() {
        assert!(destination("/tmp/invoices", "invoice-1.pdf").is_ok());
        for bad in ["../escape.pdf", "sub/dir.pdf", "..", "  ", "a\\b.pdf"] {
            assert!(destination("/tmp/invoices", bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
