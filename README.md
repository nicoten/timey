# timey

A desktop time tracker built with [Tauri v2](https://tauri.app), React, and SQLite.

Time entries are entered by hand — there is no running timer. An entry belongs to
a project, has a name, a start time, and a duration in 15-minute increments.

## Requirements

- Node 20+ and pnpm
- Rust (stable)
- [`sqlx-cli`](https://crates.io/crates/sqlx-cli), only if you change SQL:
  `cargo install sqlx-cli --no-default-features --features sqlite,rustls`

## Running

```sh
pnpm install
pnpm tauri dev
```

The database is created on first launch inside the platform app-data directory —
on macOS `~/Library/Application Support/com.nicotejera.timey/timey.db`. Migrations
are embedded in the binary and run at startup, before the window appears.

## Tests

```sh
pnpm test:rust
```

Runs against a real in-memory SQLite database with the production migrations
applied, so the schema's constraints are exercised rather than mocked.

## Data model

```
clients ──< contacts
   │
   └──< projects ──< entries
```

- **clients** — `name` unique among live rows, case-insensitively. Archiving frees the name.
- **contacts** — name and email, many per client. An email may serve several clients
  but cannot repeat within one. Deleted with their client (`ON DELETE CASCADE`).
- **projects** — a `code` (required, unique across all live projects, case-insensitive)
  plus a name unique within the client. `hourly_rate_cents` is integer cents, never a float.
- **entries** — `project_id`, `name`, `started_at`, `duration_minutes`.

Deleting a client with projects, or a project with entries, fails by design
(`ON DELETE RESTRICT`) — archive instead, so logged hours are never silently lost.

### Two kinds of timestamp

- `started_at` is **local wall-clock**, `YYYY-MM-DDTHH:MM`. It stores the time you
  typed, so an entry never drifts to another day across travel or a DST change. The
  format sorts lexically, so a plain `2026-08-27` works as a range bound.
- `created_at`, `updated_at`, and `archived_at` are **UTC instants** with a `Z`
  suffix. They are audit data, not user intent.

An entry has no stored end time: it is `started_at + duration_minutes`, derived on
read, so the same fact is never stored in two places.

### Enforced in the schema, not just the UI

`duration_minutes` must be positive, a multiple of 15, and at most 24 hours;
`started_at` must match the expected format and land on a 15-minute boundary. These
are CHECK constraints, so no code path — including a future one — can write a
malformed entry. `src-tauri/src/validate.rs` applies the same rules earlier to
produce a readable message instead of a raw constraint violation.

Overlapping entries are **allowed** by the database; flagging a double-booking is
left to the UI.

## Architecture

```
src-tauri/src/
  db/         SQL, knows nothing about Tauri — testable with plain `cargo test`
  commands/   thin #[tauri::command] wrappers over db/
  validate.rs input rules, mirroring the schema's CHECK constraints
  error.rs    AppError; turns SQLite constraint text into readable messages
  model.rs    row types, serialized to the frontend as camelCase
src/lib/api.ts  typed wrappers over invoke — the only place the frontend calls it
```

The frontend never writes SQL. Every rule lives in one place on the Rust side, which
also means it can be tested without launching the app.

## Changing SQL

Queries are verified against the schema at compile time, so a mistyped column fails
`cargo build` rather than at runtime. That needs schema metadata available at build
time, which is what the committed `src-tauri/.sqlx/` cache provides — a clean clone
builds with no database present.

**After editing any SQL, regenerate the cache or the build will fail:**

```sh
pnpm db:setup     # once: creates the gitignored src-tauri/dev.db
pnpm db:prepare   # after every SQL change
```

`src-tauri/.env` points sqlx at `dev.db` and is committed deliberately — it holds a
local path, no secrets. To add a migration, put a new numbered file in
`src-tauri/migrations/` and run `pnpm db:setup`.
