//! Handing an invoice to the mail app.
//!
//! `mailto:` cannot carry an attachment — the parameter is non-standard and
//! ignored or blocked everywhere — so attaching means scripting a specific
//! client. Apple Mail can be driven with AppleScript; anything else falls back
//! to a prefilled `mailto:` with the file revealed in Finder.

use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];

/// What the frontend still has to do after this runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAction {
    /// True when a draft was opened with the PDF already attached.
    pub attached: bool,
    pub recipients: Vec<String>,
    /// Present only when the caller must open it, the PDF being unattached.
    pub mailto: Option<String>,
    pub file_path: String,
}

/// `Invoice 20 — Sam Rivera — August 2026`
pub fn subject(number: i64, sender: &str, period_start: &str) -> String {
    format!("Invoice {number} — {sender} — {}", month_year(period_start))
}

/// The wording asked for, with a blank line before the sign-off.
pub fn body(sender: &str, period_start: &str) -> String {
    format!(
        "Please find my invoice for {} attached.\n\nBest,\n{sender}",
        numeric_month_year(period_start)
    )
}

/// `2026-08-01` -> `August 2026`.
fn month_year(period_start: &str) -> String {
    let year = &period_start[0..4];
    let index = period_start[5..7].parse::<usize>().unwrap_or(1).clamp(1, 12) - 1;
    format!("{} {year}", MONTHS[index])
}

/// `2026-08-01` -> `08/2026`.
fn numeric_month_year(period_start: &str) -> String {
    format!("{}/{}", &period_start[5..7], &period_start[0..4])
}

/// Percent-encodes for a `mailto:` query, where a space must be `%20`.
fn encode(value: &str) -> String {
    urlencoding::encode(value).replace('+', "%20")
}

pub fn mailto_url(recipients: &[String], subject: &str, body: &str) -> String {
    format!(
        "mailto:{}?subject={}&body={}",
        recipients.join(","),
        encode(subject),
        encode(body)
    )
}

/// The bundle id handling `mailto:`, from Launch Services.
///
/// `None` means no explicit choice has been recorded, which on macOS means
/// Apple Mail.
pub fn parse_mail_handler(launch_services_json: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(launch_services_json).ok()?;
    let handlers = parsed.get("LSHandlers")?.as_array()?;

    for handler in handlers {
        if handler.get("LSHandlerURLScheme")?.as_str()? == "mailto" {
            return handler
                .get("LSHandlerRoleAll")
                .and_then(|role| role.as_str())
                .map(|role| role.to_lowercase());
        }
    }

    None
}

/// True when Apple Mail handles `mailto:`, so scripting it is the right move.
pub fn is_apple_mail(handler: Option<&str>) -> bool {
    match handler {
        None => true,
        Some(bundle_id) => bundle_id == "com.apple.mail",
    }
}

#[cfg(target_os = "macos")]
fn default_mail_handler() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let plist = format!(
        "{home}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"
    );

    let output = Command::new("plutil")
        .args(["-convert", "json", "-o", "-", &plist])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_mail_handler(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn default_mail_handler() -> Option<String> {
    // Nothing else has an Apple Mail to script.
    Some(String::new())
}

/// The AppleScript that builds the draft.
///
/// Values arrive as arguments rather than interpolated into the source, so a
/// quote in a client's name cannot break — or rewrite — the script.
const DRAFT_SCRIPT: &str = r#"
on run argv
  set theSubject to item 1 of argv
  set theBody to item 2 of argv
  set thePath to item 3 of argv
  tell application "Mail"
    set msg to make new outgoing message with properties {subject:theSubject, content:theBody, visible:true}
    if (count of argv) > 3 then
      repeat with i from 4 to (count of argv)
        tell msg to make new to recipient at end of to recipients with properties {address:(item i of argv) as text}
      end repeat
    end if
    tell msg
      make new attachment with properties {file name:(POSIX file thePath)} at after the last paragraph of content
    end tell
    activate
  end tell
end run
"#;

/// Opens an Apple Mail draft with the invoice attached.
#[cfg(target_os = "macos")]
fn draft_in_apple_mail(
    subject: &str,
    body: &str,
    file_path: &str,
    recipients: &[String],
) -> AppResult<()> {
    use std::io::Write;

    let mut child = Command::new("osascript")
        .arg("-")
        .arg(subject)
        .arg(body)
        .arg(file_path)
        .args(recipients)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| AppError::validation(format!("could not run osascript: {err}")))?;

    child
        .stdin
        .as_mut()
        .ok_or_else(|| AppError::validation("could not talk to osascript"))?
        .write_all(DRAFT_SCRIPT.as_bytes())
        .map_err(|err| AppError::validation(format!("could not send the script: {err}")))?;

    let output = child
        .wait_with_output()
        .map_err(|err| AppError::validation(format!("osascript failed: {err}")))?;

    if output.status.success() {
        return Ok(());
    }

    Err(AppError::validation(
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

#[cfg(not(target_os = "macos"))]
fn draft_in_apple_mail(_: &str, _: &str, _: &str, _: &[String]) -> AppResult<()> {
    Err(AppError::validation("Apple Mail is only available on macOS"))
}

/// Drafts in Apple Mail when it is the default, otherwise reports what the
/// caller should open instead.
pub fn compose(
    number: i64,
    sender: &str,
    period_start: &str,
    file_path: &str,
    recipients: Vec<String>,
) -> AppResult<EmailAction> {
    if recipients.is_empty() {
        return Err(AppError::validation(
            "This client has no contacts to send to. Add one in Settings.",
        ));
    }

    let subject = subject(number, sender, period_start);
    let body = body(sender, period_start);

    let handler = default_mail_handler();

    if is_apple_mail(handler.as_deref()) {
        // A scripting failure is not fatal: the prefilled message still works,
        // it just cannot carry the file.
        if draft_in_apple_mail(&subject, &body, file_path, &recipients).is_ok() {
            return Ok(EmailAction {
                attached: true,
                recipients,
                mailto: None,
                file_path: file_path.to_string(),
            });
        }
    }

    Ok(EmailAction {
        attached: false,
        mailto: Some(mailto_url(&recipients, &subject, &body)),
        recipients,
        file_path: file_path.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_names_the_invoice_month_and_sender() {
        assert_eq!(
            subject(20, "Sam Rivera", "2026-08-01"),
            "Invoice 20 — Sam Rivera — August 2026"
        );
        assert_eq!(
            subject(1, "A", "2025-12-01"),
            "Invoice 1 — A — December 2025"
        );
    }

    #[test]
    fn body_matches_the_requested_wording() {
        assert_eq!(
            body("Sam Rivera", "2026-08-01"),
            "Please find my invoice for 08/2026 attached.\n\nBest,\nSam Rivera"
        );
    }

    #[test]
    fn mailto_encodes_spaces_as_percent_twenty() {
        let url = mailto_url(
            &["a@b.com".to_string(), "c@d.com".to_string()],
            "Invoice 20 — A",
            "Line one\n\nBest,\nA",
        );

        assert!(url.starts_with("mailto:a@b.com,c@d.com?"));
        // A "+" in a mailto body renders as a literal plus, not a space.
        assert!(!url.contains('+'), "{url}");
        assert!(url.contains("%20"), "{url}");
        assert!(url.contains("subject=Invoice%2020"), "{url}");
    }

    #[test]
    fn launch_services_yields_the_mailto_handler() {
        let json = r#"{
            "LSHandlers": [
                {"LSHandlerURLScheme": "http", "LSHandlerRoleAll": "com.apple.Safari"},
                {"LSHandlerURLScheme": "mailto", "LSHandlerRoleAll": "com.microsoft.Outlook"}
            ]
        }"#;
        assert_eq!(parse_mail_handler(json).as_deref(), Some("com.microsoft.outlook"));
    }

    #[test]
    fn no_recorded_handler_means_apple_mail() {
        assert!(is_apple_mail(None), "an unset default is Apple Mail on macOS");
        assert!(is_apple_mail(Some("com.apple.mail")));
        assert!(!is_apple_mail(Some("com.microsoft.outlook")));

        // Missing key, missing array, and unparseable input all read as unset.
        assert_eq!(parse_mail_handler("{}"), None);
        assert_eq!(parse_mail_handler("not json"), None);
        assert_eq!(
            parse_mail_handler(r#"{"LSHandlers":[{"LSHandlerURLScheme":"http"}]}"#),
            None
        );
    }

    #[test]
    fn composing_without_contacts_is_refused() {
        let error = compose(1, "A", "2026-08-01", "/tmp/x.pdf", vec![]).unwrap_err();
        assert!(error.to_string().contains("no contacts"), "{error}");
    }
}
