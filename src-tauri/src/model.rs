//! Row types shared by the database layer, the commands, and (via camelCase
//! serialization) the TypeScript wrappers in `src/lib/api.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub id: i64,
    pub name: String,
    /// UTC instant, `Z`-suffixed. Non-null means archived.
    pub archived_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: i64,
    pub client_id: i64,
    pub name: String,
    pub email: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub client_id: i64,
    /// Short handle, unique across all live projects.
    pub code: String,
    pub name: String,
    pub color: Option<String>,
    /// Integer cents, never a float.
    pub hourly_rate_cents: Option<i64>,
    pub archived_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    /// Local wall-clock, `YYYY-MM-DDTHH:MM`, on the 15-minute grid.
    pub started_at: String,
    pub duration_minutes: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// An entry joined to its project and client, with the end time derived rather
/// than stored. This is what list views actually need.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetail {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub started_at: String,
    pub duration_minutes: i64,
    /// `started_at + duration_minutes`, computed on read.
    pub ended_at: String,
    pub project_code: String,
    pub project_name: String,
    pub client_id: i64,
    pub client_name: String,
}
