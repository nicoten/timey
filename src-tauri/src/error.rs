//! One error type crossing the Rust/TypeScript boundary.
//!
//! Raw SQLite messages ("UNIQUE constraint failed: index 'projects_active_code'")
//! are useless in a UI, so `from_sqlx` translates the constraint violations the
//! schema can actually produce into messages worth showing someone.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Input rejected before it reached the database.
    #[error("{0}")]
    Validation(String),

    /// A row the caller named does not exist.
    #[error("{entity} {id} does not exist")]
    NotFound { entity: &'static str, id: i64 },

    /// The write collided with something already stored.
    #[error("{0}")]
    Conflict(String),

    #[error("database error: {0}")]
    Database(String),

    #[error("could not open the database: {0}")]
    Io(String),
}

impl AppError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    /// Short machine-readable discriminant, so the frontend can branch on the
    /// kind of failure without matching on prose.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation",
            Self::NotFound { .. } => "notFound",
            Self::Conflict(_) => "conflict",
            Self::Database(_) => "database",
            Self::Io(_) => "io",
        }
    }

    /// Map a sqlx error onto a user-facing one. Constraint names are matched
    /// against the indexes declared in `migrations/0001_initial_schema.sql`;
    /// keep the two in step.
    pub fn from_sqlx(err: sqlx::Error) -> Self {
        let sqlx::Error::Database(db) = &err else {
            return Self::Database(err.to_string());
        };

        let message = db.message().to_string();

        if message.contains("UNIQUE constraint failed") {
            let explanation = if message.contains("clients_active_name") {
                "A client with that name already exists."
            } else if message.contains("contacts_client_email") {
                "That email is already a contact for this client."
            } else if message.contains("projects_active_code") {
                "That project code is already in use."
            } else if message.contains("projects_active_name") {
                "This client already has a project with that name."
            } else {
                "That value is already taken."
            };
            return Self::Conflict(explanation.to_string());
        }

        if message.contains("FOREIGN KEY constraint failed") {
            return Self::Conflict(
                "That record is still referenced by others, or points at something \
                 that no longer exists."
                    .to_string(),
            );
        }

        if message.contains("CHECK constraint failed") {
            return Self::Validation(format!("The database rejected this value ({message})."));
        }

        Self::Database(message)
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        Self::from_sqlx(err)
    }
}

impl From<sqlx::migrate::MigrateError> for AppError {
    fn from(err: sqlx::migrate::MigrateError) -> Self {
        Self::Database(format!("migration failed: {err}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

/// Serialized as `{ kind, message }` so a caught error in TypeScript is a plain
/// object rather than a stringified enum.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
