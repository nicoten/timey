# timey

A macOS menu bar time tracker built with [Tauri v2](https://tauri.app), React,
and SQLite.

It lives as a clock icon in the menu bar with no Dock icon and no window of its
own: clicking the icon opens a popover anchored beneath it, and it dismisses when
it loses focus. Right-clicking the icon gives Settings and Quit.

Time entries are entered by hand — there is no running timer. An entry belongs to
a project, has a name, a start time, and a duration in 15-minute increments. The
month reads as a shaded grid: one circle per day, deeper the longer the day, with
hours and earnings in a tooltip on hover.

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

**No window appears at launch, by design.** Look for the clock icon in the menu
bar and click it. The app is a menu bar accessory (`ActivationPolicy::Accessory`),
so it has no Dock icon and shows no menu bar of its own — quit from the icon's
right-click menu.

The database is created on first launch inside the platform app-data directory —
on macOS `~/Library/Application Support/com.nicotejera.timey/timey.db`. Migrations
are embedded in the binary and run at startup, before the window appears.

## Tests

```sh
pnpm test:rust
```

Runs against a real in-memory SQLite database with the production migrations
applied, so the schema's constraints are exercised rather than mocked.

## Invoicing

Settings needs two things before an invoice can be issued: **your name**, which
appears after "From", and a **folder** to write PDFs into. Clients carry an EIN
and an address, both printed on the document.

The invoice action in the popover header asks for a client, a month, and which
projects to include — everything with a rate is preselected. Projects without an
hourly rate are listed but cannot be picked: their time is real, it just cannot
be billed.

One line per project, quantity in decimal hours, and an amount computed from the
project's whole minute total so that `quantity × unit price` equals the amount
printed beside it. Invoice numbers are a running sequence, unique in the
database, so two invoices can never share one.

Issued invoices are stored line by line rather than recomputed on demand. A rate
change must not rewrite a document that has already been sent, and deleting a
client that has been invoiced fails for the same reason.

### Emailing an invoice

After an invoice is saved, **Email to contacts** opens a draft addressed to every
contact on that client, with a subject naming the invoice, month and sender, and
the requested body.

`mailto:` cannot carry an attachment — the parameter is non-standard and ignored
or blocked everywhere — so attaching means scripting a specific client. When
Apple Mail is the default, Timey drives it with AppleScript and the PDF is
already attached; macOS asks once for permission to control Mail, which is why
the build carries the `com.apple.security.automation.apple-events` entitlement
(the hardened runtime blocks Apple Events without it). Any other default mail app
gets a prefilled message with the PDF revealed in Finder to drag in, and the UI
says so rather than implying the file went with it.

The PDF is drawn with jsPDF in the frontend and written by Rust. jsPDF ships the
Helvetica metrics needed to right-align the figure columns, which is the one
thing a hand-rolled writer cannot do without reproducing a font's width tables.

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
- **invoices / invoice_lines** — one row per issued document, with its lines frozen
  at the moment of issue.
- **settings** — key/value, for the invoice folder and sender name. These shape
  files on disk, so they belong beside the data rather than in browser storage.

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

## Releasing and auto-update

Installed copies check for a new version once per launch and never install
anything without being asked. The check is silent when nothing is available, or
when it fails — only an explicit check in **Settings → Updates** reports errors.

### Cutting a release

The app version lives in three manifests that must agree, because the updater
compares the installed version against what the manifest advertises. Drift means
either a missed release or one that is offered forever. One command sets all
three:

```sh
pnpm test:rust
pnpm set-version 0.2.0
cargo check --manifest-path src-tauri/Cargo.toml   # refresh Cargo.lock
git commit -am "Release v0.2.0"
git tag v0.2.0
git push --follow-tags
```

The tag is a marker, not a trigger: nothing is published until the bundle is
built and uploaded. That happens here, on the machine holding the signing key,
because `.github/workflows/release.yml` is `workflow_dispatch` only — see its
header for why, and for what to add to make the runner the release path.

```sh
pnpm tauri build
cd src-tauri/target/release/bundle/macos
gh release create v0.2.0 --title "Timey 0.2.0" --notes "..." \
  latest.json Timey.app.tar.gz Timey.app.tar.gz.sig
```

The three assets are what the updater reads: `latest.json` advertises the
version, and the `.sig` is what the app checks the bundle against. A release
missing any of them is a release installed copies cannot take.

### How updates are trusted

Update bundles are signed with a minisign keypair. The public half is in
`src-tauri/tauri.conf.json`; the private half is **not in this repo** — it lives
at `~/.tauri/timey.key` and in the `TAURI_SIGNING_PRIVATE_KEY` repository
secret. The app refuses any bundle that does not verify against the public key,
so the update channel does not depend on trusting GitHub.

**Keep a backup of `~/.tauri/timey.key`.** Losing it means already-installed
copies can never be updated again — a new key would produce bundles they reject,
and the only way forward is reinstalling by hand.

### macOS signing

Builds are not signed with an Apple Developer ID or notarized. Updating a copy
on your own machine works, because the updater writes the new bundle without a
quarantine flag. Installing on **someone else's** Mac would show Gatekeeper
warnings; clearing those needs a paid Apple Developer account and a notarization
step in the workflow.

### Endpoint

`https://github.com/nicoten/timey/releases/latest/download/latest.json`

GitHub redirects `/releases/latest/` to the newest published release, so the
endpoint never changes. This requires the repository to stay public — release
assets inherit repository visibility, and the updater fetches them
unauthenticated.
