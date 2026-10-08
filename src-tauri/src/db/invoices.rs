//! Invoice preparation and issuing.
//!
//! An invoice is computed from entries once, then stored line by line. It is a
//! document that has been sent to someone: re-deriving it later from live
//! projects would let a rate change rewrite history.

use std::path::{Path, PathBuf};

use crate::db::{settings, Db};
use crate::error::{AppError, AppResult};
use crate::model::{
    Client, InvoiceCandidate, InvoiceDraft, InvoiceLine, InvoicePeriod, IssuedInvoice,
    IssuedInvoiceSummary,
};
use crate::validate;

/// What one line earns, rounded to the cent.
///
/// Computed from the line's whole minute total rather than by summing rounded
/// per-entry amounts, so `quantity × unit price` on the page equals the amount
/// beside it — the arithmetic the person reading the invoice will check.
pub fn line_amount_cents(rate_cents: i64, minutes: i64) -> i64 {
    (rate_cents * minutes + 30) / 60
}

/// The invoice ID as printed: `ACME-12`, or `12` for a client without a code.
pub fn label(code: Option<&str>, number: i64) -> String {
    match code {
        Some(code) => format!("{code}-{number}"),
        None => number.to_string(),
    }
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

/// Every project of this client with entries in `[from, to)`.
///
/// Projects without a rate are included so the picker can show why their time
/// cannot be billed, rather than silently omitting time that was tracked.
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
               p.hourly_rate_cents AS "hourly_rate_cents",
               CAST(coalesce(sum(e.amount_cents), 0) AS INTEGER) AS "fixed_cents!: i64",
               CAST(count(e.amount_cents) AS INTEGER) AS "fixed_count!: i64"
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
            fixed_cents: row.fixed_cents,
            fixed_count: row.fixed_count,
        })
        .collect())
}

/// One project's fixed-price entries in `[from, to)`, each to become a line.
async fn fixed_entries(
    db: &Db,
    project_id: i64,
    from: &str,
    to: &str,
) -> AppResult<Vec<(String, String, i64)>> {
    let rows = sqlx::query!(
        r#"
        SELECT name                     AS "name!",
               substr(started_at, 1, 10) AS "day!: String",
               amount_cents             AS "amount_cents!: i64"
        FROM entries
        WHERE project_id = ?1
          AND amount_cents IS NOT NULL
          AND started_at >= ?2
          AND started_at <  ?3
        ORDER BY started_at, id
        "#,
        project_id,
        from,
        to
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| (row.name, row.day, row.amount_cents))
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
    let period = InvoicePeriod {
        from: from.to_string(),
        to: to.to_string(),
        project_ids: project_ids.to_vec(),
    };
    let mut drafts = prepare_many(db, client_id, &[period]).await?;
    Ok(drafts.remove(0))
}

/// Builds one invoice per period, numbered in chronological order: the earliest
/// period takes the client's next number, the one after it the number after.
pub async fn prepare_many(
    db: &Db,
    client_id: i64,
    periods: &[InvoicePeriod],
) -> AppResult<Vec<InvoiceDraft>> {
    if periods.is_empty() {
        return Err(AppError::validation("Pick at least one month to invoice."));
    }

    let client = crate::db::clients::get(db, client_id).await?;
    let sender_name = settings::require(db, settings::SENDER_NAME, "your name").await?;
    // Checked now rather than after rendering, so the failure arrives early.
    settings::require(db, settings::INVOICE_FOLDER, "an invoice folder").await?;
    let issue_date = settings::today_local(db).await?;

    let mut ordered = Vec::with_capacity(periods.len());
    for period in periods {
        let from = validate::date_bound("from", &period.from)?;
        let to = validate::date_bound("to", &period.to)?;
        ordered.push((from, to, &period.project_ids));
    }
    ordered.sort_by(|a, b| a.0.cmp(&b.0));

    if ordered.windows(2).any(|pair| pair[1].0 < pair[0].1) {
        return Err(AppError::validation("The periods to invoice overlap."));
    }

    let numbers = free_numbers(db, client_id, client.next_invoice_number, ordered.len()).await?;

    let mut drafts = Vec::with_capacity(ordered.len());
    for ((from, to, project_ids), number) in ordered.into_iter().zip(numbers) {
        let lines = build_lines(db, client_id, project_ids, &from, &to).await?;
        drafts.push(draft(&client, &sender_name, &issue_date, number, from, to, lines)?);
    }
    Ok(drafts)
}

/// The lines for one period, in the order they are printed.
async fn build_lines(
    db: &Db,
    client_id: i64,
    project_ids: &[i64],
    period_start: &str,
    period_end: &str,
) -> AppResult<Vec<InvoiceLine>> {
    if project_ids.is_empty() {
        return Err(AppError::validation("Pick at least one project to invoice."));
    }

    let period_end_inclusive = validate::previous_day(period_end)?;
    let available = candidates(db, client_id, period_start, period_end).await?;
    let mut lines = Vec::new();

    for candidate in available {
        if !project_ids.contains(&candidate.project_id) {
            continue;
        }

        if candidate.minutes > 0 {
            let rate_cents = candidate.hourly_rate_cents.ok_or_else(|| {
                AppError::validation(format!(
                    "{} has no hourly rate, so its time cannot be invoiced. Add one in Settings.",
                    candidate.code
                ))
            })?;

            lines.push(InvoiceLine {
                project_id: candidate.project_id,
                description: format!(
                    "[{}] {} ({} - {})",
                    candidate.code,
                    candidate.name,
                    us_date(period_start),
                    us_date(&period_end_inclusive)
                ),
                minutes: Some(candidate.minutes),
                rate_cents,
                amount_cents: line_amount_cents(rate_cents, candidate.minutes),
            });
        }

        if candidate.fixed_count > 0 {
            for (name, day, amount_cents) in
                fixed_entries(db, candidate.project_id, period_start, period_end).await?
            {
                lines.push(InvoiceLine {
                    project_id: candidate.project_id,
                    description: format!("[{}] {} ({})", candidate.code, name, us_date(&day)),
                    minutes: None,
                    rate_cents: amount_cents,
                    amount_cents,
                });
            }
        }
    }

    if lines.is_empty() {
        return Err(AppError::validation(format!(
            "Nothing was logged against those projects between {} and {}.",
            us_date(period_start),
            us_date(&period_end_inclusive)
        )));
    }

    Ok(lines)
}

fn draft(
    client: &Client,
    sender_name: &str,
    issue_date: &str,
    number: i64,
    period_start: String,
    period_end: String,
    lines: Vec<InvoiceLine>,
) -> AppResult<InvoiceDraft> {
    let period_end_inclusive = validate::previous_day(&period_end)?;
    let total_cents = lines.iter().map(|line| line.amount_cents).sum();
    let code_part = client
        .code
        .as_deref()
        .map(|code| format!("{}-", slug(code)))
        .unwrap_or_default();

    Ok(InvoiceDraft {
        file_name: format!(
            "invoice-{code_part}{number:04}-{}-{}.pdf",
            slug(&client.name),
            &period_start[0..7]
        ),
        number,
        label: label(client.code.as_deref(), number),
        issue_date: issue_date.to_string(),
        client: client.clone(),
        sender_name: sender_name.to_string(),
        period_start,
        period_end,
        period_end_inclusive,
        lines,
        total_cents,
    })
}

/// Every invoice issued to this client, latest period first, with the projects
/// each one billed.
pub async fn issued_for_client(db: &Db, client_id: i64) -> AppResult<Vec<IssuedInvoiceSummary>> {
    let invoices = sqlx::query!(
        r#"
        SELECT id           AS "id!: i64",
               number       AS "number!: i64",
               client_code,
               issue_date   AS "issue_date!",
               period_start AS "period_start!",
               period_end   AS "period_end!",
               total_cents  AS "total_cents!: i64",
               currency     AS "currency!",
               file_path    AS "file_path!"
        FROM invoices
        WHERE client_id = ?1
        ORDER BY period_start DESC, number DESC
        "#,
        client_id
    )
    .fetch_all(db)
    .await?;

    let lines = sqlx::query!(
        r#"
        SELECT DISTINCT l.invoice_id AS "invoice_id!: i64",
                        l.project_id AS "project_id!: i64"
        FROM invoice_lines l
        JOIN invoices i ON i.id = l.invoice_id
        WHERE i.client_id = ?1 AND l.project_id IS NOT NULL
        "#,
        client_id
    )
    .fetch_all(db)
    .await?;

    Ok(invoices
        .into_iter()
        .map(|invoice| IssuedInvoiceSummary {
            project_ids: lines
                .iter()
                .filter(|line| line.invoice_id == invoice.id)
                .map(|line| line.project_id)
                .collect(),
            id: invoice.id,
            number: invoice.number,
            label: label(invoice.client_code.as_deref(), invoice.number),
            issue_date: invoice.issue_date,
            period_start: invoice.period_start,
            period_end: invoice.period_end,
            total_cents: invoice.total_cents,
            currency: invoice.currency,
            file_path: invoice.file_path,
        })
        .collect())
}

/// Everything the mail draft needs for an already-issued invoice.
pub async fn email_plan(db: &Db, invoice_id: i64) -> AppResult<EmailPlan> {
    let invoice = sqlx::query!(
        r#"
        SELECT number       AS "number!: i64",
               client_code,
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
        label: label(invoice.client_code.as_deref(), invoice.number),
        sender_name,
        period_start: invoice.period_start,
        file_path: invoice.file_path,
        recipients,
    })
}

/// The inputs to `mail::compose`, read back from a stored invoice.
pub struct EmailPlan {
    pub label: String,
    pub sender_name: String,
    pub period_start: String,
    pub file_path: String,
    pub recipients: Vec<String>,
}

/// The number this client's next invoice takes.
pub async fn next_number(db: &Db, client_id: i64) -> AppResult<i64> {
    let client = crate::db::clients::get(db, client_id).await?;
    Ok(free_numbers(db, client_id, client.next_invoice_number, 1).await?[0])
}

/// The first `count` numbers from `start` on that this client has not used.
///
/// The stored next number can be set by hand to fill a gap, so the numbers
/// after it are not necessarily free.
async fn free_numbers(db: &Db, client_id: i64, start: i64, count: usize) -> AppResult<Vec<i64>> {
    let taken: Vec<i64> = sqlx::query_scalar!(
        r#"SELECT number AS "number!: i64" FROM invoices WHERE client_id = ?1 AND number >= ?2"#,
        client_id,
        start
    )
    .fetch_all(db)
    .await?;

    let mut free = Vec::with_capacity(count);
    let mut candidate = start;
    while free.len() < count {
        if !taken.contains(&candidate) {
            free.push(candidate);
        }
        candidate += 1;
    }
    Ok(free)
}

/// Records the invoice and writes the rendered PDF.
pub async fn issue(db: &Db, draft: &InvoiceDraft, pdf: &[u8]) -> AppResult<IssuedInvoice> {
    let mut issued = issue_many(db, &[(draft.clone(), pdf.to_vec())]).await?;
    Ok(issued.remove(0))
}

/// Records the invoices and writes their PDFs, all or none.
///
/// The rows go in first and the files are written before the transaction
/// commits, so a failure leaves neither a record without a document nor a
/// number quietly consumed; files already written for the batch are removed.
pub async fn issue_many(
    db: &Db,
    invoices: &[(InvoiceDraft, Vec<u8>)],
) -> AppResult<Vec<IssuedInvoice>> {
    if invoices.is_empty() {
        return Err(AppError::validation("There were no invoices to issue."));
    }

    let folder = settings::require(db, settings::INVOICE_FOLDER, "an invoice folder").await?;
    let mut written: Vec<PathBuf> = Vec::new();

    let result = issue_in_transaction(db, &folder, invoices, &mut written).await;
    if result.is_err() {
        for path in &written {
            let _ = std::fs::remove_file(path);
        }
    }
    result
}

async fn issue_in_transaction(
    db: &Db,
    folder: &str,
    invoices: &[(InvoiceDraft, Vec<u8>)],
    written: &mut Vec<PathBuf>,
) -> AppResult<Vec<IssuedInvoice>> {
    let mut tx = db.begin().await?;
    let mut issued = Vec::with_capacity(invoices.len());

    for (draft, pdf) in invoices {
        if pdf.is_empty() {
            return Err(AppError::validation(format!(
                "The rendered invoice {} was empty.",
                draft.label
            )));
        }

        let path = destination(folder, &draft.period_start, &draft.client.name, &draft.file_name)?;
        let path_text = path.to_string_lossy().to_string();

        let invoice_id = sqlx::query!(
            r#"
            INSERT INTO invoices
                (number, client_id, client_code, issue_date, period_start, period_end,
                 total_cents, file_path, currency)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            draft.number,
            draft.client.id,
            draft.client.code,
            draft.issue_date,
            draft.period_start,
            draft.period_end,
            draft.total_cents,
            path_text,
            draft.client.currency
        )
        .execute(&mut *tx)
        .await
        .map_err(|err| match &err {
            // Numbers are unique per client, so a collision means something
            // else issued this one since the draft was prepared.
            sqlx::Error::Database(db_err) if db_err.message().contains("UNIQUE") => {
                AppError::Conflict(format!(
                    "Invoice {} already exists. Close this and start again to take the next number.",
                    draft.label
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

        // An invoice already sent is never overwritten, and a file that was
        // there before this batch is not one to clean up after a failure.
        if path.exists() {
            return Err(AppError::Conflict(format!(
                "{} already exists. Move it aside to issue invoice {}.",
                path_text, draft.label
            )));
        }
        write_pdf(&path, pdf)?;
        written.push(path);

        issued.push(IssuedInvoice {
            id: invoice_id,
            number: draft.number,
            label: draft.label.clone(),
            period_start: draft.period_start.clone(),
            total_cents: draft.total_cents,
            currency: draft.client.currency.clone(),
            file_path: path_text,
        });
    }

    // Each client's sequence continues after the highest number just issued,
    // skipping any already taken beyond it.
    let mut clients: Vec<i64> = invoices.iter().map(|(draft, _)| draft.client.id).collect();
    clients.sort_unstable();
    clients.dedup();

    for client_id in clients {
        let highest = invoices
            .iter()
            .filter(|(draft, _)| draft.client.id == client_id)
            .map(|(draft, _)| draft.number)
            .max()
            .unwrap_or(0);

        sqlx::query!(
            r#"
            WITH RECURSIVE candidate(n) AS (
                SELECT ?2 + 1
                UNION ALL
                SELECT n + 1 FROM candidate
                WHERE EXISTS (SELECT 1 FROM invoices WHERE client_id = ?1 AND number = n)
            )
            UPDATE clients SET next_invoice_number = (SELECT max(n) FROM candidate)
            WHERE id = ?1
            "#,
            client_id,
            highest
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(issued)
}

/// Where an invoice is filed: `<folder>/<year>/Q<n>/<client>/<file>`.
///
/// The year and quarter are the billing period's, not the issue date's: tax is
/// reported by the quarter the work was done in, and an invoice issued late
/// still belongs to that quarter.
///
/// Rejects a filename that tries to escape the configured folder.
fn destination(
    folder: &str,
    period_start: &str,
    client_name: &str,
    file_name: &str,
) -> AppResult<PathBuf> {
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

    let period = validate::date_bound("period start", period_start)?;
    let month: u32 = period[5..7].parse().unwrap_or(1);

    Ok(Path::new(folder)
        .join(&period[0..4])
        .join(format!("Q{}", (month - 1) / 3 + 1))
        .join(folder_name(client_name))
        .join(trimmed))
}

/// A client's name as a folder name: kept readable, with only what a path
/// cannot hold replaced, and never `.`, `..` or hidden.
fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') || c.is_control() { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "Client".to_string()
    } else {
        cleaned
    }
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
    fn invoices_are_filed_by_year_quarter_and_client() {
        let path = |period: &str| destination("/inv", period, "Acme Inc", "a.pdf").unwrap();
        assert_eq!(path("2026-01-01"), Path::new("/inv/2026/Q1/Acme Inc/a.pdf"));
        assert_eq!(path("2026-03-31"), Path::new("/inv/2026/Q1/Acme Inc/a.pdf"));
        assert_eq!(path("2026-04-01"), Path::new("/inv/2026/Q2/Acme Inc/a.pdf"));
        assert_eq!(path("2026-09-15"), Path::new("/inv/2026/Q3/Acme Inc/a.pdf"));
        assert_eq!(path("2026-12-01"), Path::new("/inv/2026/Q4/Acme Inc/a.pdf"));
        assert!(destination("/inv", "2026-01-01", "Acme", "../a.pdf").is_err());
    }

    #[test]
    fn client_names_become_safe_folder_names() {
        assert_eq!(folder_name("Northwind GmbH"), "Northwind GmbH");
        assert_eq!(folder_name("A/B: C\\D"), "A-B- C-D");
        assert_eq!(folder_name(".."), "Client");
        assert_eq!(folder_name(".hidden"), "hidden");
        assert_eq!(folder_name("   "), "Client");
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
        assert!(destination("/tmp/invoices", "2026-08-01", "Acme", "invoice-1.pdf").is_ok());
        for bad in ["../escape.pdf", "sub/dir.pdf", "..", "  ", "a\\b.pdf"] {
            assert!(destination("/tmp/invoices", "2026-08-01", "Acme", bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
