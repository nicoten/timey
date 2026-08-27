//! Integration tests for the data layer, run against a real in-memory SQLite
//! database with the production migrations applied.
//!
//! These target the invariants — the rules that must hold no matter what the UI
//! does — rather than echoing CRUD back at itself.

use timey_lib::db::{self, Db};
use timey_lib::error::AppError;

async fn fresh_db() -> Db {
    db::connect_in_memory().await.expect("in-memory database")
}

/// A client with one project, the usual starting point.
async fn client_with_project(db: &Db) -> (i64, i64) {
    let client = db::clients::create(db, "Acme", None, None).await.expect("client");
    let project = db::projects::create(db, client.id, "ACME-001", "Website", None, None)
        .await
        .expect("project");
    (client.id, project.id)
}

fn assert_kind(error: AppError, expected: &str) {
    assert_eq!(error.kind(), expected, "unexpected error: {error}");
}

// --- migrations ------------------------------------------------------------

#[tokio::test]
async fn migrations_are_idempotent() {
    let db = fresh_db().await;
    // A second run against an already-migrated database must be a no-op.
    db::connect_in_memory().await.expect("second database");
    assert!(db::clients::list(&db, false).await.unwrap().is_empty());
}

// --- clients ---------------------------------------------------------------

#[tokio::test]
async fn client_names_are_unique_case_insensitively() {
    let db = fresh_db().await;
    db::clients::create(&db, "Acme", None, None).await.unwrap();

    let error = db::clients::create(&db, "ACME", None, None).await.unwrap_err();
    assert_kind(error, "conflict");
}

#[tokio::test]
async fn archiving_a_client_frees_its_name() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();

    db::clients::set_archived(&db, client.id, true).await.unwrap();
    let reused = db::clients::create(&db, "Acme", None, None).await.expect("name should be free");

    assert_ne!(reused.id, client.id);
}

#[tokio::test]
async fn listing_clients_hides_archived_unless_asked() {
    let db = fresh_db().await;
    let kept = db::clients::create(&db, "Kept", None, None).await.unwrap();
    let gone = db::clients::create(&db, "Gone", None, None).await.unwrap();
    db::clients::set_archived(&db, gone.id, true).await.unwrap();

    let visible = db::clients::list(&db, false).await.unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].id, kept.id);

    assert_eq!(db::clients::list(&db, true).await.unwrap().len(), 2);
}

#[tokio::test]
async fn unarchiving_clears_the_timestamp() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();

    let archived = db::clients::set_archived(&db, client.id, true).await.unwrap();
    assert!(archived.archived_at.is_some());

    let restored = db::clients::set_archived(&db, client.id, false).await.unwrap();
    assert!(restored.archived_at.is_none());
}

#[tokio::test]
async fn blank_client_names_are_rejected() {
    let db = fresh_db().await;
    assert_kind(db::clients::create(&db, "   ", None, None).await.unwrap_err(), "validation");
}

#[tokio::test]
async fn operating_on_a_missing_client_reports_not_found() {
    let db = fresh_db().await;
    assert_kind(db::clients::update(&db, 404, "Ghost", None, None).await.unwrap_err(), "notFound");
    assert_kind(db::clients::delete(&db, 404).await.unwrap_err(), "notFound");
    assert_kind(db::clients::get(&db, 404).await.unwrap_err(), "notFound");
}

// --- contacts --------------------------------------------------------------

#[tokio::test]
async fn a_client_can_hold_several_contacts() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();

    db::contacts::create(&db, client.id, "Ann", "ann@acme.com").await.unwrap();
    db::contacts::create(&db, client.id, "Bob", "bob@acme.com").await.unwrap();

    let contacts = db::contacts::list_for_client(&db, client.id).await.unwrap();
    assert_eq!(contacts.len(), 2);
    // Ordered by name.
    assert_eq!(contacts[0].name, "Ann");
}

#[tokio::test]
async fn the_same_email_may_serve_two_clients_but_not_one_twice() {
    let db = fresh_db().await;
    let acme = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let globex = db::clients::create(&db, "Globex", None, None).await.unwrap();

    db::contacts::create(&db, acme.id, "Ann", "ann@example.com").await.unwrap();
    db::contacts::create(&db, globex.id, "Ann", "ann@example.com")
        .await
        .expect("same person, different client");

    let error = db::contacts::create(&db, acme.id, "Ann Again", "ANN@EXAMPLE.COM")
        .await
        .unwrap_err();
    assert_kind(error, "conflict");
}

#[tokio::test]
async fn contacts_reject_malformed_emails() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();

    for bad in ["", "ann", "ann@", "ann@acme", "a b@c.com"] {
        let error = db::contacts::create(&db, client.id, "Ann", bad).await.unwrap_err();
        assert_kind(error, "validation");
    }
}

#[tokio::test]
async fn a_contact_needs_an_existing_client() {
    let db = fresh_db().await;
    let error = db::contacts::create(&db, 404, "Ann", "ann@acme.com").await.unwrap_err();
    // Proves foreign keys are actually enforced; SQLite has them off by default.
    assert_kind(error, "conflict");
}

#[tokio::test]
async fn deleting_a_client_takes_its_contacts_with_it() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();
    db::contacts::create(&db, client.id, "Ann", "ann@acme.com").await.unwrap();

    db::clients::delete(&db, client.id).await.expect("no projects, so deletable");

    assert!(db::contacts::list_for_client(&db, client.id).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_contact_email_can_be_corrected() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let contact = db::contacts::create(&db, client.id, "Ann", "typo@acme.com").await.unwrap();

    let fixed = db::contacts::update(&db, contact.id, "Ann Smith", "ann@acme.com").await.unwrap();

    assert_eq!(fixed.email, "ann@acme.com");
    assert_eq!(fixed.name, "Ann Smith");
    assert_eq!(fixed.id, contact.id);
}

// --- projects --------------------------------------------------------------

#[tokio::test]
async fn project_codes_are_globally_unique_case_insensitively() {
    let db = fresh_db().await;
    let acme = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let globex = db::clients::create(&db, "Globex", None, None).await.unwrap();

    db::projects::create(&db, acme.id, "P-001", "Website", None, None).await.unwrap();

    // Same code under a *different* client must still collide.
    let error = db::projects::create(&db, globex.id, "p-001", "Other", None, None)
        .await
        .unwrap_err();
    assert_kind(error, "conflict");
}

#[tokio::test]
async fn archiving_a_project_frees_its_code() {
    let db = fresh_db().await;
    let (client_id, project_id) = client_with_project(&db).await;

    db::projects::set_archived(&db, project_id, true).await.unwrap();
    db::projects::create(&db, client_id, "ACME-001", "Website v2", None, None)
        .await
        .expect("code should be free");
}

#[tokio::test]
async fn projects_require_a_code_and_a_name() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();

    assert_kind(
        db::projects::create(&db, client.id, "  ", "Website", None, None).await.unwrap_err(),
        "validation",
    );
    assert_kind(
        db::projects::create(&db, client.id, "ACME-002", "", None, None).await.unwrap_err(),
        "validation",
    );
}

#[tokio::test]
async fn project_colors_must_be_hex_and_rates_non_negative() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();

    let ok = db::projects::create(&db, client.id, "C-1", "P", Some("#AABBCC".into()), Some(15_000))
        .await
        .unwrap();
    assert_eq!(ok.color.as_deref(), Some("#aabbcc"));
    assert_eq!(ok.hourly_rate_cents, Some(15_000));

    assert_kind(
        db::projects::create(&db, client.id, "C-2", "P", Some("red".into()), None).await.unwrap_err(),
        "validation",
    );
    assert_kind(
        db::projects::create(&db, client.id, "C-3", "P", None, Some(-1)).await.unwrap_err(),
        "validation",
    );
}

#[tokio::test]
async fn projects_can_be_filtered_by_client() {
    let db = fresh_db().await;
    let acme = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let globex = db::clients::create(&db, "Globex", None, None).await.unwrap();
    db::projects::create(&db, acme.id, "A-1", "One", None, None).await.unwrap();
    db::projects::create(&db, globex.id, "G-1", "Two", None, None).await.unwrap();

    assert_eq!(db::projects::list(&db, Some(acme.id), false).await.unwrap().len(), 1);
    assert_eq!(db::projects::list(&db, None, false).await.unwrap().len(), 2);
}

#[tokio::test]
async fn a_client_holding_projects_cannot_be_deleted() {
    let db = fresh_db().await;
    let (client_id, _) = client_with_project(&db).await;

    let error = db::clients::delete(&db, client_id).await.unwrap_err();
    assert_kind(error, "conflict");
}

// --- entries ---------------------------------------------------------------

#[tokio::test]
async fn entries_reject_durations_off_the_fifteen_minute_grid() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;

    for good in [15, 30, 90, 1440] {
        db::entries::create(&db, project_id, "Work", "2026-08-27T09:15", good)
            .await
            .unwrap_or_else(|error| panic!("{good} minutes should be accepted: {error}"));
    }

    for bad in [7, 0, -15, 20, 1455] {
        let error = db::entries::create(&db, project_id, "Work", "2026-08-27T09:15", bad)
            .await
            .unwrap_err();
        assert_kind(error, "validation");
    }
}

#[tokio::test]
async fn entries_reject_start_times_off_the_grid_or_malformed() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;

    for bad in [
        "2026-08-27T09:07",
        "2026-08-27T25:00",
        "2026-8-27T09:15",
        "2026-08-27 09:15",
        "2026-02-30T09:15",
        "",
    ] {
        let error = db::entries::create(&db, project_id, "Work", bad, 60).await.unwrap_err();
        assert_kind(error, "validation");
    }
}

#[tokio::test]
async fn an_entry_needs_an_existing_project() {
    let db = fresh_db().await;
    let error = db::entries::create(&db, 404, "Work", "2026-08-27T09:15", 60).await.unwrap_err();
    assert_kind(error, "conflict");
}

#[tokio::test]
async fn a_project_holding_entries_cannot_be_deleted() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;
    db::entries::create(&db, project_id, "Work", "2026-08-27T09:15", 60).await.unwrap();

    let error = db::projects::delete(&db, project_id).await.unwrap_err();
    assert_kind(error, "conflict");
}

#[tokio::test]
async fn end_time_is_derived_from_start_plus_duration() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;
    db::entries::create(&db, project_id, "Work", "2026-08-27T09:15", 90).await.unwrap();
    // Crossing midnight must roll the date forward.
    db::entries::create(&db, project_id, "Late", "2026-08-27T23:30", 60).await.unwrap();

    let entries = db::entries::list_in_range(&db, "2026-08-27", "2026-08-28", None).await.unwrap();

    assert_eq!(entries[0].ended_at, "2026-08-27T10:45");
    assert_eq!(entries[1].ended_at, "2026-08-28T00:30");
}

#[tokio::test]
async fn listing_entries_joins_project_and_client_detail() {
    let db = fresh_db().await;
    let (client_id, project_id) = client_with_project(&db).await;
    db::entries::create(&db, project_id, "Work", "2026-08-27T09:15", 60).await.unwrap();

    let entries = db::entries::list_in_range(&db, "2026-08-27", "2026-08-28", None).await.unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].project_code, "ACME-001");
    assert_eq!(entries[0].project_name, "Website");
    assert_eq!(entries[0].client_id, client_id);
    assert_eq!(entries[0].client_name, "Acme");
    assert_eq!(entries[0].hourly_rate_cents, None);
}

#[tokio::test]
async fn listing_entries_carries_the_projects_rate_for_earnings() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let project = db::projects::create(&db, client.id, "ACME-001", "Website", None, Some(15_000))
        .await
        .unwrap();
    db::entries::create(&db, project.id, "Work", "2026-08-27T09:15", 90).await.unwrap();

    let entries = db::entries::list_in_range(&db, "2026-08-27", "2026-08-28", None).await.unwrap();

    assert_eq!(entries[0].hourly_rate_cents, Some(15_000));
}

#[tokio::test]
async fn the_range_bound_is_inclusive_at_the_start_and_exclusive_at_the_end() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;
    for day in ["2026-08-26", "2026-08-27", "2026-08-28"] {
        db::entries::create(&db, project_id, "Work", &format!("{day}T09:15"), 60).await.unwrap();
    }

    let entries = db::entries::list_in_range(&db, "2026-08-27", "2026-08-28", None).await.unwrap();

    assert_eq!(entries.len(), 1, "only the 27th belongs to [27th, 28th)");
    assert_eq!(entries[0].started_at, "2026-08-27T09:15");
}

#[tokio::test]
async fn entries_can_be_filtered_to_one_project() {
    let db = fresh_db().await;
    let (client_id, first) = client_with_project(&db).await;
    let second = db::projects::create(&db, client_id, "ACME-002", "App", None, None)
        .await
        .unwrap();
    db::entries::create(&db, first, "A", "2026-08-27T09:15", 60).await.unwrap();
    db::entries::create(&db, second.id, "B", "2026-08-27T10:15", 60).await.unwrap();

    let filtered = db::entries::list_in_range(&db, "2026-08-27", "2026-08-28", Some(second.id))
        .await
        .unwrap();

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].name, "B");
}

#[tokio::test]
async fn entries_are_returned_in_chronological_order() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;
    for start in ["2026-08-27T14:00", "2026-08-27T09:15", "2026-08-27T11:30"] {
        db::entries::create(&db, project_id, "Work", start, 60).await.unwrap();
    }

    let entries = db::entries::list_in_range(&db, "2026-08-27", "2026-08-28", None).await.unwrap();
    let starts: Vec<&str> = entries.iter().map(|e| e.started_at.as_str()).collect();

    assert_eq!(starts, ["2026-08-27T09:15", "2026-08-27T11:30", "2026-08-27T14:00"]);
}

#[tokio::test]
async fn overlapping_entries_are_permitted() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;

    db::entries::create(&db, project_id, "First", "2026-08-27T09:00", 120).await.unwrap();
    db::entries::create(&db, project_id, "Second", "2026-08-27T10:00", 60)
        .await
        .expect("overlap is a UI-level warning, not a database rule");
}

#[tokio::test]
async fn an_entry_can_be_edited_and_moved_between_projects() {
    let db = fresh_db().await;
    let (client_id, first) = client_with_project(&db).await;
    let second = db::projects::create(&db, client_id, "ACME-002", "App", None, None)
        .await
        .unwrap();
    let entry = db::entries::create(&db, first, "Work", "2026-08-27T09:15", 60).await.unwrap();

    let moved = db::entries::update(&db, entry.id, second.id, "Rework", "2026-08-27T13:00", 45)
        .await
        .unwrap();

    assert_eq!(moved.project_id, second.id);
    assert_eq!(moved.name, "Rework");
    assert_eq!(moved.started_at, "2026-08-27T13:00");
    assert_eq!(moved.duration_minutes, 45);
    assert_eq!(moved.created_at, entry.created_at, "creation time must not move");
}

#[tokio::test]
async fn editing_an_entry_still_enforces_the_grid() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;
    let entry = db::entries::create(&db, project_id, "Work", "2026-08-27T09:15", 60).await.unwrap();

    let error = db::entries::update(&db, entry.id, project_id, "Work", "2026-08-27T09:15", 7)
        .await
        .unwrap_err();
    assert_kind(error, "validation");

    // The stored row is untouched.
    assert_eq!(db::entries::get(&db, entry.id).await.unwrap().duration_minutes, 60);
}

#[tokio::test]
async fn entries_can_be_deleted_and_deleting_twice_reports_not_found() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;
    let entry = db::entries::create(&db, project_id, "Work", "2026-08-27T09:15", 60).await.unwrap();

    db::entries::delete(&db, entry.id).await.unwrap();
    assert_kind(db::entries::delete(&db, entry.id).await.unwrap_err(), "notFound");
}

// --- reporting -------------------------------------------------------------

#[tokio::test]
async fn daily_totals_sum_minutes_per_calendar_day() {
    let db = fresh_db().await;
    let (_, project_id) = client_with_project(&db).await;

    db::entries::create(&db, project_id, "A", "2026-08-27T09:00", 90).await.unwrap();
    db::entries::create(&db, project_id, "B", "2026-08-27T13:00", 30).await.unwrap();
    db::entries::create(&db, project_id, "C", "2026-08-28T09:00", 60).await.unwrap();
    // Outside the window.
    db::entries::create(&db, project_id, "D", "2026-09-01T09:00", 60).await.unwrap();

    let totals = db::entries::daily_totals(&db, "2026-08-27", "2026-08-29").await.unwrap();

    assert_eq!(
        totals,
        vec![("2026-08-27".to_string(), 120), ("2026-08-28".to_string(), 60)]
    );
}

#[tokio::test]
async fn daily_totals_reject_a_malformed_bound() {
    let db = fresh_db().await;
    assert_kind(
        db::entries::daily_totals(&db, "not-a-date", "2026-08-29").await.unwrap_err(),
        "validation",
    );
}

// --- error surface ---------------------------------------------------------

#[tokio::test]
async fn conflicts_carry_a_message_worth_showing_a_person() {
    let db = fresh_db().await;
    db::clients::create(&db, "Acme", None, None).await.unwrap();

    let error = db::clients::create(&db, "Acme", None, None).await.unwrap_err();
    let message = error.to_string();

    assert!(
        message.contains("already exists"),
        "raw SQLite text leaked to the UI: {message}"
    );
    assert!(!message.contains("UNIQUE constraint"), "leaked internals: {message}");
}

// --- nullable round-trips --------------------------------------------------
//
// Regression guard. sqlx's SQLite driver decodes a NULL returned from an
// `UPDATE ... RETURNING` clause as `Some("")` instead of `None`, so every update
// writes and then reads back inside a transaction. These tests fail if anyone
// reintroduces `UPDATE ... RETURNING`.

#[tokio::test]
async fn a_new_row_reports_its_nullable_fields_as_absent() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();
    assert_eq!(client.archived_at, None);

    let project = db::projects::create(&db, client.id, "P-1", "Site", None, None)
        .await
        .unwrap();
    assert_eq!(project.color, None);
    assert_eq!(project.hourly_rate_cents, None);
    assert_eq!(project.archived_at, None);
}

#[tokio::test]
async fn renaming_a_live_client_does_not_invent_an_archive_timestamp() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();

    let renamed = db::clients::update(&db, client.id, "Acme Ltd", None, None).await.unwrap();

    assert_eq!(renamed.name, "Acme Ltd");
    assert_eq!(renamed.archived_at, None, "a live client must have no archive timestamp");
}

#[tokio::test]
async fn renaming_an_archived_client_preserves_its_timestamp() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let archived = db::clients::set_archived(&db, client.id, true).await.unwrap();

    let renamed = db::clients::update(&db, client.id, "Acme Ltd", None, None).await.unwrap();

    assert_eq!(renamed.archived_at, archived.archived_at);
}

#[tokio::test]
async fn clearing_a_projects_optional_fields_reads_back_as_absent() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let project = db::projects::create(
        &db,
        client.id,
        "P-1",
        "Site",
        Some("#aabbcc".into()),
        Some(15_000),
    )
    .await
    .unwrap();

    let cleared = db::projects::update(&db, project.id, "P-1", "Site", None, None)
        .await
        .unwrap();

    assert_eq!(cleared.color, None);
    assert_eq!(cleared.hourly_rate_cents, None);
    assert_eq!(cleared.archived_at, None);
}

#[tokio::test]
async fn what_an_update_returns_matches_what_was_stored() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();

    db::clients::set_archived(&db, client.id, true).await.unwrap();
    let returned = db::clients::set_archived(&db, client.id, false).await.unwrap();
    let stored = db::clients::get(&db, client.id).await.unwrap();

    assert_eq!(returned, stored, "the returned row must equal the stored row");
    assert_eq!(returned.archived_at, None);
}

#[tokio::test]
async fn a_failed_update_leaves_the_row_untouched() {
    let db = fresh_db().await;
    let acme = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let globex = db::clients::create(&db, "Globex", None, None).await.unwrap();

    // Renaming Globex onto a taken name must fail and roll back.
    let error = db::clients::update(&db, globex.id, "Acme", None, None).await.unwrap_err();
    assert_kind(error, "conflict");

    assert_eq!(db::clients::get(&db, globex.id).await.unwrap().name, "Globex");
    assert_eq!(db::clients::get(&db, acme.id).await.unwrap().name, "Acme");
}

// --- the on-disk connection path -------------------------------------------
//
// Every test above uses the in-memory database. These cover `db::connect`
// itself: directory creation, pragmas, and reopening an existing file.

fn scratch_dir(label: &str) -> std::path::PathBuf {
    let unique = format!("timey-test-{}-{label}", std::process::id());
    std::env::temp_dir().join(unique)
}

#[tokio::test]
async fn connecting_creates_the_file_and_any_missing_directories() {
    let root = scratch_dir("create");
    let _ = std::fs::remove_dir_all(&root);
    // A nested path the app has never seen, as on a first launch.
    let path = root.join("nested").join("timey.db");

    let db = db::connect(&path).await.expect("connect");

    assert!(path.exists(), "database file should have been created");
    assert!(db::clients::list(&db, false).await.unwrap().is_empty());

    db.close().await;
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn an_on_disk_database_enforces_foreign_keys_and_uses_wal() {
    let root = scratch_dir("pragmas");
    let _ = std::fs::remove_dir_all(&root);
    let path = root.join("timey.db");

    let db = db::connect(&path).await.expect("connect");

    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(foreign_keys, 1, "foreign keys must be on; SQLite defaults them off");

    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(journal_mode.to_lowercase(), "wal");

    // Prove the pragma actually bites on a pooled connection.
    let error = db::entries::create(&db, 404, "Work", "2026-08-27T09:15", 60)
        .await
        .unwrap_err();
    assert_kind(error, "conflict");

    db.close().await;
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn data_survives_closing_and_reopening_the_database() {
    let root = scratch_dir("reopen");
    let _ = std::fs::remove_dir_all(&root);
    let path = root.join("timey.db");

    let db = db::connect(&path).await.expect("first open");
    let client = db::clients::create(&db, "Acme", None, None).await.unwrap();
    let project = db::projects::create(&db, client.id, "ACME-001", "Website", None, None)
        .await
        .unwrap();
    db::entries::create(&db, project.id, "Work", "2026-08-27T09:15", 90)
        .await
        .unwrap();
    db.close().await;

    // Reopening runs migrations again; they must be a no-op over existing data.
    let reopened = db::connect(&path).await.expect("second open");
    let entries = db::entries::list_in_range(&reopened, "2026-08-27", "2026-08-28", None)
        .await
        .unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "Work");
    assert_eq!(entries[0].ended_at, "2026-08-27T10:45");
    assert_eq!(entries[0].client_name, "Acme");

    reopened.close().await;
    std::fs::remove_dir_all(&root).ok();
}

// --- invoicing -------------------------------------------------------------

use timey_lib::db::settings;

/// A client with a rated project and time logged in August 2026.
async fn billable_setup(db: &Db) -> (i64, i64) {
    let client = db::clients::create(db, "InData", Some("133448682".into()), Some("390 Riverside Drive\nNew York, NY 10025".into()))
        .await
        .unwrap();
    let project = db::projects::create(db, client.id, "XQ1", "XQ", None, Some(15_500))
        .await
        .unwrap();
    // 17.5 hours, the figure from the reference invoice.
    db::entries::create(db, project.id, "Work", "2026-08-03T09:00", 480).await.unwrap();
    db::entries::create(db, project.id, "Work", "2026-08-04T09:00", 480).await.unwrap();
    db::entries::create(db, project.id, "Work", "2026-08-05T09:00", 90).await.unwrap();

    settings::set(db, settings::SENDER_NAME, "Nicolas Tejera").await.unwrap();
    (client.id, project.id)
}

#[tokio::test]
async fn settings_round_trip_and_blank_removes() {
    let db = fresh_db().await;

    settings::set(&db, "sender_name", "  Nicolas Tejera  ").await.unwrap();
    assert_eq!(
        settings::get(&db, "sender_name").await.unwrap().as_deref(),
        Some("Nicolas Tejera"),
        "stored values are trimmed"
    );

    // Setting the same key again replaces rather than failing on the primary key.
    settings::set(&db, "sender_name", "Someone Else").await.unwrap();
    assert_eq!(
        settings::get(&db, "sender_name").await.unwrap().as_deref(),
        Some("Someone Else")
    );

    settings::set(&db, "sender_name", "   ").await.unwrap();
    assert_eq!(settings::get(&db, "sender_name").await.unwrap(), None, "blank clears the key");
}

#[tokio::test]
async fn clients_carry_billing_details() {
    let db = fresh_db().await;
    let client = db::clients::create(&db, "InData", Some("133448682".into()), Some("390 Riverside Drive".into()))
        .await
        .unwrap();

    assert_eq!(client.ein.as_deref(), Some("133448682"));
    assert_eq!(client.address.as_deref(), Some("390 Riverside Drive"));

    // Blank fields are stored as absent, not as empty strings.
    let cleared = db::clients::update(&db, client.id, "InData", Some("  ".into()), None)
        .await
        .unwrap();
    assert_eq!(cleared.ein, None);
    assert_eq!(cleared.address, None);

    // And they survive a reread.
    assert_eq!(db::clients::get(&db, client.id).await.unwrap().ein, None);
}

#[tokio::test]
async fn candidates_report_billable_time_for_the_period() {
    let db = fresh_db().await;
    let (client_id, project_id) = billable_setup(&db).await;

    let found = db::invoices::candidates(&db, client_id, "2026-08-01", "2026-09-01").await.unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].project_id, project_id);
    assert_eq!(found[0].minutes, 17 * 60 + 30);
    assert_eq!(found[0].hourly_rate_cents, Some(15_500));

    // A month with nothing logged offers nothing.
    assert!(db::invoices::candidates(&db, client_id, "2026-07-01", "2026-08-01")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn candidates_include_unrated_projects_so_the_picker_can_explain() {
    let db = fresh_db().await;
    let (client_id, _) = billable_setup(&db).await;
    let unrated = db::projects::create(&db, client_id, "NR1", "No rate", None, None).await.unwrap();
    db::entries::create(&db, unrated.id, "Work", "2026-08-06T09:00", 60).await.unwrap();

    let found = db::invoices::candidates(&db, client_id, "2026-08-01", "2026-09-01").await.unwrap();
    let no_rate = found.iter().find(|c| c.project_id == unrated.id).unwrap();

    assert_eq!(no_rate.hourly_rate_cents, None, "tracked time is not hidden just because it cannot be billed");
}

#[tokio::test]
async fn prepare_builds_the_document_from_the_reference_invoice() {
    let db = fresh_db().await;
    let (client_id, project_id) = billable_setup(&db).await;
    settings::set(&db, settings::INVOICE_FOLDER, "/tmp/timey-invoices").await.unwrap();

    let draft = db::invoices::prepare(&db, client_id, &[project_id], "2026-08-01", "2026-09-01")
        .await
        .unwrap();

    assert_eq!(draft.number, 1, "the first invoice takes number 1");
    assert_eq!(draft.sender_name, "Nicolas Tejera");
    assert_eq!(draft.client.ein.as_deref(), Some("133448682"));
    assert_eq!(draft.period_end_inclusive, "2026-08-31", "the document shows the last day billed");
    assert_eq!(draft.lines.len(), 1);
    assert_eq!(draft.lines[0].description, "[XQ1] XQ (08/01/2026 - 08/31/2026)");
    assert_eq!(draft.lines[0].minutes, 1050);
    assert_eq!(draft.lines[0].rate_cents, 15_500);
    assert_eq!(draft.lines[0].amount_cents, 271_250);
    assert_eq!(draft.total_cents, 271_250);
    assert_eq!(draft.file_name, "invoice-0001-indata-2026-08.pdf");
}

#[tokio::test]
async fn prepare_refuses_without_the_settings_it_needs() {
    let db = fresh_db().await;
    let (client_id, project_id) = billable_setup(&db).await;

    // Sender name is set by the fixture; the folder is not.
    let error = db::invoices::prepare(&db, client_id, &[project_id], "2026-08-01", "2026-09-01")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("invoice folder"), "{error}");
    assert_kind(error, "validation");
}

#[tokio::test]
async fn prepare_refuses_an_empty_selection_or_an_unrated_project() {
    let db = fresh_db().await;
    let (client_id, _) = billable_setup(&db).await;
    settings::set(&db, settings::INVOICE_FOLDER, "/tmp/timey-invoices").await.unwrap();

    assert_kind(
        db::invoices::prepare(&db, client_id, &[], "2026-08-01", "2026-09-01").await.unwrap_err(),
        "validation",
    );

    let unrated = db::projects::create(&db, client_id, "NR1", "No rate", None, None).await.unwrap();
    db::entries::create(&db, unrated.id, "Work", "2026-08-06T09:00", 60).await.unwrap();
    let error = db::invoices::prepare(&db, client_id, &[unrated.id], "2026-08-01", "2026-09-01")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("no hourly rate"), "{error}");
}

#[tokio::test]
async fn issuing_writes_the_file_and_records_the_lines() {
    let db = fresh_db().await;
    let (client_id, project_id) = billable_setup(&db).await;
    let folder = scratch_dir("invoices");
    let _ = std::fs::remove_dir_all(&folder);
    settings::set(&db, settings::INVOICE_FOLDER, folder.to_str().unwrap()).await.unwrap();

    let draft = db::invoices::prepare(&db, client_id, &[project_id], "2026-08-01", "2026-09-01")
        .await
        .unwrap();
    let issued = db::invoices::issue(&db, &draft, b"%PDF-1.4 pretend").await.unwrap();

    assert_eq!(issued.number, 1);
    let written = std::path::Path::new(&issued.file_path);
    assert!(written.exists(), "the PDF should be on disk at {}", issued.file_path);
    assert_eq!(std::fs::read(written).unwrap(), b"%PDF-1.4 pretend");

    let lines: i64 = sqlx::query_scalar("SELECT count(*) FROM invoice_lines WHERE invoice_id = ?")
        .bind(issued.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(lines, 1, "the lines are stored, not recomputed later");

    std::fs::remove_dir_all(&folder).ok();
}

#[tokio::test]
async fn the_number_sequence_runs_forward() {
    let db = fresh_db().await;
    let (client_id, project_id) = billable_setup(&db).await;
    let folder = scratch_dir("sequence");
    let _ = std::fs::remove_dir_all(&folder);
    settings::set(&db, settings::INVOICE_FOLDER, folder.to_str().unwrap()).await.unwrap();

    assert_eq!(db::invoices::next_number(&db).await.unwrap(), 1);

    for expected in 1..=3 {
        let draft = db::invoices::prepare(&db, client_id, &[project_id], "2026-08-01", "2026-09-01")
            .await
            .unwrap();
        assert_eq!(draft.number, expected);
        db::invoices::issue(&db, &draft, b"%PDF").await.unwrap();
    }

    assert_eq!(db::invoices::next_number(&db).await.unwrap(), 4);
    std::fs::remove_dir_all(&folder).ok();
}

#[tokio::test]
async fn reissuing_a_taken_number_is_refused_and_writes_nothing() {
    let db = fresh_db().await;
    let (client_id, project_id) = billable_setup(&db).await;
    let folder = scratch_dir("collision");
    let _ = std::fs::remove_dir_all(&folder);
    settings::set(&db, settings::INVOICE_FOLDER, folder.to_str().unwrap()).await.unwrap();

    let draft = db::invoices::prepare(&db, client_id, &[project_id], "2026-08-01", "2026-09-01")
        .await
        .unwrap();
    db::invoices::issue(&db, &draft, b"%PDF").await.unwrap();

    // The same draft again still carries number 1, which is now taken.
    let error = db::invoices::issue(&db, &draft, b"%PDF second").await.unwrap_err();
    assert_kind(error, "conflict");

    let invoices: i64 = sqlx::query_scalar("SELECT count(*) FROM invoices")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(invoices, 1, "the failed attempt left no record");

    std::fs::remove_dir_all(&folder).ok();
}

#[tokio::test]
async fn an_empty_render_is_refused() {
    let db = fresh_db().await;
    let (client_id, project_id) = billable_setup(&db).await;
    settings::set(&db, settings::INVOICE_FOLDER, "/tmp/timey-empty").await.unwrap();

    let draft = db::invoices::prepare(&db, client_id, &[project_id], "2026-08-01", "2026-09-01")
        .await
        .unwrap();
    assert_kind(db::invoices::issue(&db, &draft, b"").await.unwrap_err(), "validation");
}

#[tokio::test]
async fn a_client_with_invoices_cannot_be_deleted() {
    let db = fresh_db().await;
    let (client_id, project_id) = billable_setup(&db).await;
    let folder = scratch_dir("restrict");
    let _ = std::fs::remove_dir_all(&folder);
    settings::set(&db, settings::INVOICE_FOLDER, folder.to_str().unwrap()).await.unwrap();

    let draft = db::invoices::prepare(&db, client_id, &[project_id], "2026-08-01", "2026-09-01")
        .await
        .unwrap();
    db::invoices::issue(&db, &draft, b"%PDF").await.unwrap();

    // Clear the entries and the project, so the invoice is the only thing left
    // holding the client. Without this the test would pass on the project's own
    // RESTRICT and prove nothing about invoices.
    sqlx::query("DELETE FROM entries").execute(&db).await.unwrap();
    db::projects::delete(&db, project_id).await.unwrap();

    let error = db::clients::delete(&db, client_id).await.unwrap_err();
    assert_kind(error, "conflict");

    // And the invoice survived the project going away.
    let orphaned: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM invoice_lines WHERE project_id IS NULL",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(orphaned, 1, "the line detaches from the project rather than vanishing");

    std::fs::remove_dir_all(&folder).ok();
}

#[tokio::test]
async fn previous_day_crosses_months_and_years() {
    use timey_lib::validate::previous_day;

    assert_eq!(previous_day("2026-09-01").unwrap(), "2026-08-31");
    assert_eq!(previous_day("2026-03-01").unwrap(), "2026-02-28");
    assert_eq!(previous_day("2028-03-01").unwrap(), "2028-02-29", "2028 is a leap year");
    assert_eq!(previous_day("2026-01-01").unwrap(), "2025-12-31");
    assert_eq!(previous_day("2026-08-15").unwrap(), "2026-08-14");
    assert!(previous_day("not-a-date").is_err());
}
