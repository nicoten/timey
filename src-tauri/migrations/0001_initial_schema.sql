-- timey initial schema
--
-- Timestamp conventions, deliberately two different things:
--   * `started_at` is LOCAL WALL-CLOCK, 'YYYY-MM-DDTHH:MM'. It records the time
--     you typed, so an entry never drifts to a different day across travel or DST.
--   * `created_at` / `archived_at` / `updated_at` are UTC instants with a 'Z'
--     suffix (SQLite's 'now' is UTC). These are audit data, not user intent.
--
-- Entries have no `ended_at`: the end is `started_at + duration_minutes`, derived
-- on read, so the same fact is never stored twice.

CREATE TABLE clients (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
    archived_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Uniqueness applies only to live rows, so archiving frees the name for reuse.
CREATE UNIQUE INDEX clients_active_name ON clients (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE contacts (
    id         INTEGER PRIMARY KEY,
    -- CASCADE, unlike the RESTRICT used elsewhere: a contact has no meaning apart
    -- from its client, and dropping one loses no tracked time.
    client_id  INTEGER NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
    email      TEXT NOT NULL CHECK (length(trim(email)) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX contacts_client ON contacts (client_id);

-- The same person may be a contact for several clients, but not listed twice for one.
CREATE UNIQUE INDEX contacts_client_email ON contacts (client_id, lower(email));

CREATE TABLE projects (
    id                INTEGER PRIMARY KEY,
    client_id         INTEGER NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
    code              TEXT NOT NULL CHECK (length(trim(code)) > 0),
    name              TEXT NOT NULL CHECK (length(trim(name)) > 0),
    color             TEXT,
    -- Integer cents. Floating-point money accumulates rounding error over a month
    -- of invoices; nothing writes this until billing exists.
    hourly_rate_cents INTEGER CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents >= 0),
    archived_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Codes are global, not per-client: a code is only useful as a short handle if
-- it resolves to exactly one project.
CREATE UNIQUE INDEX projects_active_code ON projects (lower(code)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX projects_active_name ON projects (client_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE entries (
    id               INTEGER PRIMARY KEY,
    -- RESTRICT: deleting a project that holds logged hours must fail loudly.
    project_id       INTEGER NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
    started_at       TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    CHECK (duration_minutes > 0 AND duration_minutes % 15 = 0 AND duration_minutes <= 1440),
    CHECK (started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
    -- Start times sit on the same 15-minute grid as durations.
    CHECK (CAST(substr(started_at, 15, 2) AS INTEGER) % 15 = 0),
    CHECK (CAST(substr(started_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23)
);

CREATE INDEX entries_started_at ON entries (started_at);
CREATE INDEX entries_project_started ON entries (project_id, started_at);
