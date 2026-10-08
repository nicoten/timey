//! Reading payments out of a spreadsheet, for review before they become entries.
//!
//! Built around bank exports, BBVA's "Últimos movimientos" in particular: a
//! title block above the header, text dates, numeric amounts, and a currency
//! column. Nothing here assumes those positions, though. The header row is
//! found by its words and each column is confirmed by what it actually holds,
//! with a fallback to content alone when there is no recognizable header.
//!
//! Everything below `read_xlsx` works on a plain grid of `Cell`s, so detection
//! is testable without a file.

use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};

use crate::error::{AppError, AppResult};
use crate::model::{ImportColumns, ImportPreview, ImportRow};
use crate::validate;

/// How far down to look for a header before giving up on finding one.
const HEADER_SEARCH_ROWS: usize = 30;

/// A spreadsheet value, reduced to the kinds detection cares about.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    Text(String),
    Number(f64),
    /// An Excel serial date: days since 1899-12-30, fraction being the time.
    Date(f64),
}

/// The first sheet of the workbook at `path`, read and detected.
pub fn read_xlsx(path: &Path) -> AppResult<ImportPreview> {
    let mut workbook = open_workbook_auto(path)
        .map_err(|err| AppError::validation(format!("Could not open the spreadsheet: {err}")))?;

    let sheet_name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| AppError::validation("The spreadsheet has no sheets."))?;

    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|err| AppError::validation(format!("Could not read `{sheet_name}`: {err}")))?;

    // Pad out to A1, so grid positions are spreadsheet positions and row
    // numbers in messages match what the person sees.
    let (top, left) = range.start().unwrap_or((0, 0));
    let mut grid: Vec<Vec<Cell>> = vec![Vec::new(); top as usize];
    for row in range.rows() {
        let mut cells = vec![Cell::Empty; left as usize];
        cells.extend(row.iter().map(cell_from));
        grid.push(cells);
    }

    detect(&sheet_name, &grid)
}

fn cell_from(data: &Data) -> Cell {
    match data {
        Data::Int(value) => Cell::Number(*value as f64),
        Data::Float(value) => Cell::Number(*value),
        Data::String(text) | Data::DateTimeIso(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Cell::Empty
            } else {
                Cell::Text(trimmed.to_string())
            }
        }
        Data::DateTime(value) if value.is_datetime() => Cell::Date(value.as_f64()),
        _ => Cell::Empty,
    }
}

// --- detection --------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Role {
    Date,
    Description,
    Amount,
    Currency,
}

/// What a header cell names, and how strongly: lower ranks are preferred when
/// several columns could fill the same role.
fn classify_header(text: &str) -> Option<(Role, u8)> {
    let words = normalize(text);
    let has = |needle: &str| words.split(' ').any(|word| word == needle);

    // Balances look like amounts by content, so they are ruled out by name.
    if ["saldo", "disponible", "balance"].iter().any(|word| has(word)) {
        return None;
    }

    if has("valor") || words == "value date" {
        // The value date, which the bank settles on, rather than the day the
        // payment was made.
        return Some((Role::Date, 1));
    }
    if has("fecha") || has("date") || has("dia") || has("day") {
        return Some((Role::Date, 0));
    }
    if has("importe") || has("amount") || has("cantidad") || has("monto") {
        return Some((Role::Amount, 0));
    }
    if has("divisa") || has("currency") || has("moneda") {
        return Some((Role::Currency, 0));
    }
    if ["concepto", "descripcion", "description", "detalle", "details", "name", "nombre"]
        .iter()
        .any(|word| has(word))
    {
        return Some((Role::Description, 0));
    }
    if ["movimiento", "observaciones", "referencia", "reference", "memo", "notes"]
        .iter()
        .any(|word| has(word))
    {
        return Some((Role::Description, 1));
    }
    None
}

/// Finds the date, description and amount columns and reads every payment.
pub fn detect(sheet_name: &str, grid: &[Vec<Cell>]) -> AppResult<ImportPreview> {
    let (header_row, columns) = match find_header(grid) {
        Some(found) => found,
        None => (None, columns_by_content(grid)?),
    };
    let first_data_row = header_row.map_or(0, |row| row + 1);

    let header_name = |column: usize| match header_row {
        Some(row) => match cell(grid, row, column) {
            Cell::Text(text) => text.clone(),
            _ => column_letter(column),
        },
        None => format!("Column {}", column_letter(column)),
    };

    let mut rows = Vec::new();
    let mut skipped_outgoing = 0;

    for index in first_data_row..grid.len() {
        // A row without a date is a footer, a subtotal, or blank.
        let Some(date) = parse_date(cell(grid, index, columns.date)) else {
            continue;
        };
        let Some(amount_cents) = parse_amount(cell(grid, index, columns.amount)) else {
            continue;
        };
        if amount_cents <= 0 {
            skipped_outgoing += 1;
            continue;
        }

        rows.push(ImportRow {
            source_row: index as i64 + 1,
            date,
            description: columns
                .description
                .map(|column| text_of(cell(grid, index, column)))
                .unwrap_or_default(),
            amount_cents,
            currency: columns
                .currency
                .map(|column| text_of(cell(grid, index, column)).to_uppercase())
                .filter(|code| !code.is_empty()),
        });
    }

    Ok(ImportPreview {
        sheet_name: sheet_name.to_string(),
        columns: ImportColumns {
            date: header_name(columns.date),
            description: columns.description.map(header_name),
            amount: header_name(columns.amount),
            currency: columns.currency.map(header_name),
        },
        rows,
        skipped_outgoing,
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Columns {
    date: usize,
    description: Option<usize>,
    amount: usize,
    currency: Option<usize>,
}

/// The row naming the most known columns, with each pick confirmed by content.
fn find_header(grid: &[Vec<Cell>]) -> Option<(Option<usize>, Columns)> {
    let mut best: Option<(usize, usize, Columns)> = None;

    for row in 0..grid.len().min(HEADER_SEARCH_ROWS) {
        let mut candidates: Vec<(Role, u8, usize)> = grid[row]
            .iter()
            .enumerate()
            .filter_map(|(column, value)| match value {
                Cell::Text(text) => classify_header(text).map(|(role, rank)| (role, rank, column)),
                _ => None,
            })
            .collect();
        if candidates.is_empty() {
            continue;
        }
        // Stable, so equal ranks keep left-to-right order.
        candidates.sort_by_key(|(_, rank, _)| *rank);

        let below = &grid[row + 1..];
        let pick = |role: Role, fits: fn(&Cell) -> bool| {
            candidates
                .iter()
                .filter(|(candidate, _, _)| *candidate == role)
                .map(|(_, _, column)| *column)
                .find(|column| mostly(below, *column, fits))
        };

        let (Some(date), Some(amount)) = (
            pick(Role::Date, |value| parse_date(value).is_some()),
            pick(Role::Amount, |value| parse_amount(value).is_some()),
        ) else {
            continue;
        };
        let columns = Columns {
            date,
            amount,
            description: pick(Role::Description, |value| matches!(value, Cell::Text(_))),
            currency: pick(Role::Currency, |value| matches!(value, Cell::Text(_))),
        };

        if best.as_ref().map_or(true, |(_, score, _)| candidates.len() > *score) {
            best = Some((row, candidates.len(), columns));
        }
    }

    best.map(|(row, _, columns)| (Some(row), columns))
}

/// No header: the first column of dates, the first of amounts after it, and
/// the text column that varies most.
fn columns_by_content(grid: &[Vec<Cell>]) -> AppResult<Columns> {
    let width = grid.iter().map(Vec::len).max().unwrap_or(0);
    let fits_all = |column: usize, fits: fn(&Cell) -> bool| mostly(grid, column, fits);

    let date = (0..width)
        .find(|column| fits_all(*column, |value| parse_date(value).is_some()))
        .ok_or_else(|| AppError::validation("Could not find a column of dates in the spreadsheet."))?;
    let amount = (0..width)
        .filter(|column| *column != date)
        .find(|column| fits_all(*column, |value| matches!(value, Cell::Number(_))))
        .or_else(|| {
            (0..width)
                .filter(|column| *column != date)
                .find(|column| fits_all(*column, |value| parse_amount(value).is_some()))
        })
        .ok_or_else(|| AppError::validation("Could not find a column of amounts in the spreadsheet."))?;

    let description = (0..width)
        .filter(|column| *column != date && *column != amount)
        .filter(|column| fits_all(*column, |value| matches!(value, Cell::Text(_))))
        .max_by_key(|column| {
            let mut seen: Vec<&str> = grid
                .iter()
                .filter_map(|row| match row.get(*column) {
                    Some(Cell::Text(text)) => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            seen.sort_unstable();
            seen.dedup();
            // `max_by_key` keeps the last of equals; prefer the leftmost.
            (seen.len(), std::cmp::Reverse(*column))
        });

    Ok(Columns { date, description, amount, currency: None })
}

/// At least half of the column's non-empty values fit, and at least one does.
fn mostly(rows: &[Vec<Cell>], column: usize, fits: fn(&Cell) -> bool) -> bool {
    let values: Vec<&Cell> = rows
        .iter()
        .filter_map(|row| row.get(column))
        .filter(|value| **value != Cell::Empty)
        .collect();
    let fitting = values.iter().filter(|value| fits(value)).count();
    fitting > 0 && fitting * 2 >= values.len()
}

fn cell(grid: &[Vec<Cell>], row: usize, column: usize) -> &Cell {
    grid.get(row).and_then(|cells| cells.get(column)).unwrap_or(&Cell::Empty)
}

fn text_of(value: &Cell) -> String {
    match value {
        Cell::Text(text) => text.clone(),
        Cell::Number(number) => number.to_string(),
        Cell::Date(_) => parse_date(value).unwrap_or_default(),
        Cell::Empty => String::new(),
    }
}

/// `A`, `B`, …, `Z`, `AA`, … for a zero-based column.
fn column_letter(column: usize) -> String {
    let mut letters = Vec::new();
    let mut remaining = column + 1;
    while remaining > 0 {
        let digit = (remaining - 1) % 26;
        letters.push(b'A' + digit as u8);
        remaining = (remaining - 1) / 26;
    }
    letters.reverse();
    String::from_utf8(letters).unwrap_or_default()
}

/// Lower case, accents removed, punctuation turned to spaces, spaces collapsed:
/// `"F.Valor"` becomes `"f valor"` and `"Descripción"` becomes `"descripcion"`.
fn normalize(text: &str) -> String {
    let folded: String = text
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

// --- values -----------------------------------------------------------------

/// A date as `YYYY-MM-DD`. Slashed and dashed dates are read day first, as
/// Spanish banks write them; ISO dates are read as ISO.
pub fn parse_date(value: &Cell) -> Option<String> {
    match value {
        Cell::Date(serial) => from_excel_serial(*serial),
        Cell::Text(text) => parse_date_text(text),
        _ => None,
    }
}

fn parse_date_text(text: &str) -> Option<String> {
    // Drop any time of day: "17/09/2026 10:32" or "2026-09-17T10:32:00".
    let day_part = text.trim().split([' ', 'T']).next()?;

    let parts: Vec<&str> = day_part.split(['/', '-', '.']).collect();
    let [first, second, third] = parts.as_slice() else {
        return None;
    };
    if !parts.iter().all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }

    let (year, month, day) = if first.len() == 4 {
        (first.parse().ok()?, second.parse().ok()?, third.parse().ok()?)
    } else {
        let year: i64 = third.parse().ok()?;
        let year = match third.len() {
            2 => 2000 + year,
            4 => year,
            _ => return None,
        };
        (year, second.parse().ok()?, first.parse().ok()?)
    };

    ymd(year, month, day)
}

fn ymd(year: i64, month: i64, day: i64) -> Option<String> {
    if !(1900..=2200).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    if day < 1 || day > validate::days_in_month(year, month) {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

/// Excel counts days from 1899-12-30 (its fictional 1900-02-29 included, which
/// that epoch accounts for).
fn from_excel_serial(serial: f64) -> Option<String> {
    if !serial.is_finite() || serial < 1.0 {
        return None;
    }
    // Days from 1970-01-01, then Howard Hinnant's civil-from-days.
    let days = serial.floor() as i64 - 25_569;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    ymd(year, month, day)
}

/// An amount in integer cents. Negative for money going out.
pub fn parse_amount(value: &Cell) -> Option<i64> {
    match value {
        Cell::Number(number) if number.is_finite() => Some((number * 100.0).round() as i64),
        Cell::Text(text) => parse_amount_text(text),
        _ => None,
    }
}

/// Spanish (`1.234,56`) or English (`1,234.56`) grouping, with an optional
/// currency mark and a sign in front, behind, or as parentheses.
fn parse_amount_text(text: &str) -> Option<i64> {
    let mut body: String = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    for mark in ["EUR", "USD", "€", "$"] {
        body = body.replace(mark, "");
    }

    let mut negative = false;
    if body.starts_with('(') && body.ends_with(')') {
        negative = true;
        body = body[1..body.len() - 1].to_string();
    }
    if let Some(rest) = body.strip_prefix('-') {
        negative = true;
        body = rest.to_string();
    } else if let Some(rest) = body.strip_suffix('-') {
        negative = true;
        body = rest.to_string();
    } else if let Some(rest) = body.strip_prefix('+') {
        body = rest.to_string();
    }

    if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
        return None;
    }

    // The decimal separator is the last mark, unless it is followed by exactly
    // three digits and is the only one of its kind, which makes it grouping
    // ("1.234" in Spain is a thousand and more, not one and a bit).
    let last_mark = body.rfind(['.', ',']);
    let decimal_at = last_mark.filter(|at| {
        let mark = body.as_bytes()[*at] as char;
        let digits_after = body.len() - at - 1;
        let marks_of_kind = body.matches(mark).count();
        let other_kind_before = body[..*at].contains(if mark == '.' { ',' } else { '.' });
        other_kind_before || (marks_of_kind == 1 && digits_after != 3)
    });

    let (whole, fraction) = match decimal_at {
        Some(at) => (&body[..at], &body[at + 1..]),
        None => (body.as_str(), ""),
    };
    let whole: String = whole.chars().filter(char::is_ascii_digit).collect();
    if whole.is_empty() && fraction.is_empty() {
        return None;
    }
    if fraction.len() > 2 {
        return None;
    }

    let whole: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    let fraction: i64 = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<i64>().ok()? * 10,
        _ => fraction.parse().ok()?,
    };
    let cents = whole.checked_mul(100)?.checked_add(fraction)?;
    Some(if negative { -cents } else { cents })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> Cell {
        Cell::Text(value.to_string())
    }

    /// The layout of a BBVA "Últimos movimientos" export, with made-up values:
    /// a title block, the header on row 5, nothing in column A, text dates.
    fn bbva_grid() -> Vec<Vec<Cell>> {
        let e = || Cell::Empty;
        let payment = |date: &str, reference: &str, amount: f64| {
            vec![
                e(),
                text(date),
                text(date),
                text("Transferencia recibida"),
                text(reference),
                Cell::Number(amount),
                text("EUR"),
                text(&reference.to_uppercase()),
            ]
        };
        vec![
            vec![e(), e(), e(), e(), e()],
            vec![e(), e(), e(), text("Últimos movimientos")],
            vec![e(), e(), e(), text("Fecha de generación del informe: 08/10/2026")],
            vec![e(), e(), e()],
            ["", "F.Valor", "Fecha", "Concepto", "Movimiento", "Importe", "Divisa", "Observaciones"]
                .iter()
                .map(|value| if value.is_empty() { e() } else { text(value) })
                .collect(),
            payment("17/09/2026", "Rt1000000001", 4500.5),
            payment("03/09/2026", "Rt1000000002", 4321.0),
            {
                let mut outgoing = payment("01/09/2026", "Rt1000000003", -120.0);
                outgoing[3] = text("Recibo");
                outgoing
            },
            payment("20/08/2026", "Rt1000000004", 4400.25),
        ]
    }

    #[test]
    fn reads_a_bbva_export() {
        let preview = detect("Sheet1", &bbva_grid()).unwrap();

        assert_eq!(preview.columns.date, "Fecha");
        assert_eq!(preview.columns.description.as_deref(), Some("Concepto"));
        assert_eq!(preview.columns.amount, "Importe");
        assert_eq!(preview.columns.currency.as_deref(), Some("Divisa"));
        assert_eq!(preview.skipped_outgoing, 1);

        let rows: Vec<(i64, &str, i64)> = preview
            .rows
            .iter()
            .map(|row| (row.source_row, row.date.as_str(), row.amount_cents))
            .collect();
        assert_eq!(
            rows,
            vec![(6, "2026-09-17", 450_050), (7, "2026-09-03", 432_100), (9, "2026-08-20", 440_025)]
        );
        assert_eq!(preview.rows[0].description, "Transferencia recibida");
        assert_eq!(preview.rows[0].currency.as_deref(), Some("EUR"));
    }

    #[test]
    fn prefers_the_operation_date_over_the_value_date() {
        let mut grid = bbva_grid();
        // Make the two dates differ so the choice is visible.
        grid[5][1] = text("18/09/2026");
        let preview = detect("Sheet1", &grid).unwrap();
        assert_eq!(preview.rows[0].date, "2026-09-17");
    }

    #[test]
    fn ignores_balance_columns() {
        let grid = vec![
            vec![text("Saldo"), text("Date"), text("Amount")],
            vec![Cell::Number(9000.0), text("2026-09-17"), text("1.234,56")],
        ];
        let preview = detect("Sheet1", &grid).unwrap();
        assert_eq!(preview.columns.amount, "Amount");
        assert_eq!(preview.rows[0].amount_cents, 123_456);
    }

    #[test]
    fn falls_back_to_content_without_a_header() {
        let grid = vec![
            vec![text("Acme"), Cell::Date(46_282.0), Cell::Number(100.0)],
            vec![text("Globex"), Cell::Date(46_283.0), Cell::Number(250.5)],
        ];
        let preview = detect("Sheet1", &grid).unwrap();
        assert_eq!(preview.columns.date, "Column B");
        assert_eq!(preview.columns.amount, "Column C");
        assert_eq!(preview.columns.description.as_deref(), Some("Column A"));
        assert_eq!(preview.rows.len(), 2);
        assert_eq!(preview.rows[1].description, "Globex");
        assert_eq!(preview.rows[1].amount_cents, 25_050);
    }

    #[test]
    fn says_what_it_could_not_find() {
        let grid = vec![vec![text("hello"), text("world")]];
        let error = detect("Sheet1", &grid).unwrap_err();
        assert!(error.to_string().contains("dates"), "{error}");
    }

    #[test]
    fn dates_are_read_day_first() {
        for (input, expected) in [
            ("17/09/2026", "2026-09-17"),
            ("3/9/2026", "2026-09-03"),
            ("03-09-2026", "2026-09-03"),
            ("03.09.26", "2026-09-03"),
            ("2026-09-03", "2026-09-03"),
            ("2026-09-03T10:15:00", "2026-09-03"),
            ("17/09/2026 10:32", "2026-09-17"),
        ] {
            assert_eq!(parse_date(&text(input)).as_deref(), Some(expected), "{input}");
        }
        for bad in ["31/02/2026", "13/13/2026", "Fecha", "", "17/09", "4500.5"] {
            assert_eq!(parse_date(&text(bad)), None, "{bad:?}");
        }
        assert_eq!(parse_date(&Cell::Number(46_282.0)), None);
    }

    #[test]
    fn excel_serials_are_dates() {
        assert_eq!(parse_date(&Cell::Date(46_282.0)).as_deref(), Some("2026-09-17"));
        assert_eq!(parse_date(&Cell::Date(45_351.5)).as_deref(), Some("2024-02-29"));
        assert_eq!(parse_date(&Cell::Date(25_569.0)).as_deref(), Some("1970-01-01"));
    }

    #[test]
    fn amounts_in_either_convention() {
        for (input, expected) in [
            ("4878,90", 487_890),
            ("4.878,90", 487_890),
            ("4,878.90", 487_890),
            ("4878.9", 487_890),
            ("1.234", 123_400),
            ("1,234", 123_400),
            ("1.234.567", 123_456_700),
            ("12,5", 1_250),
            ("€ 1.000,00", 100_000),
            ("1 000,00 EUR", 100_000),
            ("$1,000", 100_000),
            ("-120,00", -12_000),
            ("120,00-", -12_000),
            ("(120.00)", -12_000),
            ("+50", 5_000),
        ] {
            assert_eq!(parse_amount(&text(input)), Some(expected), "{input}");
        }
        for bad in ["", "abc", "1,2,3.4.5x", "12.345,678", "EUR"] {
            assert_eq!(parse_amount(&text(bad)), None, "{bad:?}");
        }
        assert_eq!(parse_amount(&Cell::Number(4878.9)), Some(487_890));
        assert_eq!(parse_amount(&Cell::Number(0.1 + 0.2)), Some(30));
    }

    #[test]
    fn header_words_ignore_case_and_accents() {
        assert_eq!(classify_header("F.Valor"), Some((Role::Date, 1)));
        assert_eq!(classify_header("FECHA"), Some((Role::Date, 0)));
        assert_eq!(classify_header("Descripción"), Some((Role::Description, 0)));
        assert_eq!(classify_header("Saldo disponible"), None);
        assert_eq!(column_letter(0), "A");
        assert_eq!(column_letter(27), "AB");
    }
}
