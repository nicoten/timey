//! Input validation, run before anything reaches SQL.
//!
//! The schema enforces the same rules with CHECK constraints, and that is the
//! real guarantee — this layer exists so a mistake produces "Duration must be a
//! multiple of 15 minutes" instead of a raw constraint violation.

use crate::error::{AppError, AppResult};

const MINUTE_GRID: i64 = 15;
const MAX_DURATION_MINUTES: i64 = 24 * 60;

/// Trim, then reject if nothing is left. Returns the trimmed value, so callers
/// store `"Acme"` rather than `"  Acme  "`.
pub fn non_empty(field: &str, value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation(format!("{field} cannot be empty.")));
    }
    Ok(trimmed.to_string())
}

/// Deliberately permissive: enough to catch a typo or a pasted name, without
/// pretending to implement RFC 5322. Real verification is sending mail.
pub fn email(value: &str) -> AppResult<String> {
    let trimmed = non_empty("Email", value)?;

    if trimmed.chars().any(char::is_whitespace) {
        return Err(AppError::validation("Email cannot contain spaces."));
    }

    let invalid = || AppError::validation(format!("`{trimmed}` is not a valid email address."));

    let (local, domain) = trimmed.split_once('@').ok_or_else(invalid)?;
    if local.is_empty() || domain.is_empty() || domain.contains('@') {
        return Err(invalid());
    }

    // Require a dotted domain with non-empty labels: `a@b` and `a@b.` are out.
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return Err(invalid());
    }

    Ok(trimmed)
}

/// Positive, on the 15-minute grid, and no longer than a day.
pub fn duration_minutes(value: i64) -> AppResult<i64> {
    if value <= 0 {
        return Err(AppError::validation("Duration must be greater than zero."));
    }
    if value % MINUTE_GRID != 0 {
        return Err(AppError::validation(format!(
            "Duration must be a multiple of {MINUTE_GRID} minutes; got {value}."
        )));
    }
    if value > MAX_DURATION_MINUTES {
        return Err(AppError::validation(format!(
            "Duration cannot exceed {MAX_DURATION_MINUTES} minutes (24 hours); got {value}."
        )));
    }
    Ok(value)
}

/// `YYYY-MM-DDTHH:MM`, a real calendar date, and a start minute on the same
/// 15-minute grid as durations.
pub fn started_at(value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    let invalid = |reason: &str| {
        AppError::validation(format!(
            "`{trimmed}` is not a valid start time ({reason}). Expected YYYY-MM-DDTHH:MM."
        ))
    };

    let bytes = trimmed.as_bytes();
    if bytes.len() != 16 {
        return Err(invalid("wrong length"));
    }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = match index {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 => *byte == b':',
            _ => byte.is_ascii_digit(),
        };
        if !ok {
            return Err(invalid("malformed"));
        }
    }

    let number = |from: usize, to: usize| trimmed[from..to].parse::<i64>().unwrap_or(-1);
    let (year, month, day) = (number(0, 4), number(5, 7), number(8, 10));
    let (hour, minute) = (number(11, 13), number(14, 16));

    if !(1..=12).contains(&month) {
        return Err(invalid("month out of range"));
    }
    if day < 1 || day > days_in_month(year, month) {
        return Err(invalid("day out of range for that month"));
    }
    if !(0..=23).contains(&hour) {
        return Err(invalid("hour out of range"));
    }
    if minute % MINUTE_GRID != 0 {
        return Err(AppError::validation(format!(
            "Start time must fall on a {MINUTE_GRID}-minute boundary; got :{minute:02}."
        )));
    }

    Ok(trimmed.to_string())
}

/// A range bound for queries: either `YYYY-MM-DD` or a full start time. Both
/// compare correctly against stored values because the format sorts lexically.
pub fn date_bound(field: &str, value: &str) -> AppResult<String> {
    let trimmed = non_empty(field, value)?;
    if trimmed.len() == 10 {
        // Reuse the full-timestamp checks by probing midnight.
        started_at(&format!("{trimmed}T00:00"))
            .map_err(|_| AppError::validation(format!("`{trimmed}` is not a valid date for {field}.")))?;
        return Ok(trimmed);
    }
    started_at(&trimmed)
}

/// Trims optional free text, turning blank into absent so the column stays NULL
/// rather than holding an empty string.
pub fn optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

/// `#rgb` or `#rrggbb`, or nothing at all.
pub fn optional_color(value: Option<String>) -> AppResult<Option<String>> {
    let Some(raw) = value else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let hex = trimmed.strip_prefix('#').unwrap_or("");
    if !(hex.len() == 3 || hex.len() == 6) || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::validation(format!(
            "`{trimmed}` is not a valid color. Use #rgb or #rrggbb."
        )));
    }
    Ok(Some(trimmed.to_lowercase()))
}

pub fn optional_rate_cents(value: Option<i64>) -> AppResult<Option<i64>> {
    match value {
        Some(cents) if cents < 0 => {
            Err(AppError::validation("Hourly rate cannot be negative."))
        }
        other => Ok(other),
    }
}

pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// The day before `date`, both as `YYYY-MM-DD`.
///
/// Invoices are queried with an exclusive end but printed with an inclusive one.
pub fn previous_day(date: &str) -> AppResult<String> {
    let bounded = date_bound("date", date)?;
    let (year, month, day) = (
        bounded[0..4].parse::<i64>().unwrap_or(0),
        bounded[5..7].parse::<i64>().unwrap_or(0),
        bounded[8..10].parse::<i64>().unwrap_or(0),
    );

    let (year, month, day) = if day > 1 {
        (year, month, day - 1)
    } else if month > 1 {
        (year, month - 1, days_in_month(year, month - 1))
    } else {
        (year - 1, 12, 31)
    };

    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_trims_and_rejects_blank() {
        assert_eq!(non_empty("Name", "  Acme  ").unwrap(), "Acme");
        assert!(non_empty("Name", "   ").is_err());
        assert!(non_empty("Name", "").is_err());
    }

    #[test]
    fn email_accepts_ordinary_addresses() {
        for good in ["a@b.com", "first.last+tag@sub.example.co.uk"] {
            assert!(email(good).is_ok(), "{good} should be accepted");
        }
        assert_eq!(email("  Ann@Acme.com ").unwrap(), "Ann@Acme.com");
    }

    #[test]
    fn email_rejects_malformed_addresses() {
        for bad in ["", "ann", "ann@", "@acme.com", "ann@acme", "a@b.", "a b@c.com", "a@@b.com"] {
            assert!(email(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn duration_enforces_the_fifteen_minute_grid() {
        for good in [15, 30, 90, 1440] {
            assert!(duration_minutes(good).is_ok(), "{good} should be accepted");
        }
        for bad in [0, -15, 7, 20, 1455] {
            assert!(duration_minutes(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn started_at_accepts_grid_aligned_wall_clock() {
        for good in ["2026-08-27T09:15", "2028-02-29T00:00", "2026-12-31T23:45"] {
            assert!(started_at(good).is_ok(), "{good} should be accepted");
        }
    }

    #[test]
    fn started_at_rejects_bad_shapes_and_impossible_dates() {
        for bad in [
            "2026-08-27T09:07",  // off the grid
            "2026-08-27T25:00",  // hour out of range
            "2026-8-27T09:15",   // unpadded month
            "2026-08-27 09:15",  // space instead of T
            "2026-13-01T00:00",  // month out of range
            "2026-02-30T00:00",  // not a real day
            "2025-02-29T00:00",  // 2025 is not a leap year
            "2026-08-27T09:15:00", // too long
            "",
        ] {
            assert!(started_at(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn date_bound_takes_dates_or_timestamps() {
        assert_eq!(date_bound("from", "2026-08-27").unwrap(), "2026-08-27");
        assert_eq!(date_bound("to", "2026-08-27T12:00").unwrap(), "2026-08-27T12:00");
        assert!(date_bound("from", "2026-02-30").is_err());
    }

    #[test]
    fn color_accepts_hex_or_nothing() {
        assert_eq!(optional_color(Some("#AABBCC".into())).unwrap(), Some("#aabbcc".into()));
        assert_eq!(optional_color(Some("#fff".into())).unwrap(), Some("#fff".into()));
        assert_eq!(optional_color(Some("   ".into())).unwrap(), None);
        assert_eq!(optional_color(None).unwrap(), None);
        assert!(optional_color(Some("red".into())).is_err());
        assert!(optional_color(Some("#ggg".into())).is_err());
    }

    #[test]
    fn leap_years_follow_the_gregorian_rule() {
        assert!(is_leap_year(2024) && is_leap_year(2000) && is_leap_year(2400));
        assert!(!is_leap_year(1900) && !is_leap_year(2025) && !is_leap_year(2100));
    }
}
