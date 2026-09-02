#!/bin/bash
set -e

echo "Starting database initialization..."

# --------------------------------------------
# Configurable paths — default to the Docker
# /docker-entrypoint-initdb.d* layout but allow
# overrides for local dev or custom deployments.
# --------------------------------------------
SQL_DIR="${SQL_DIR:-/docker-entrypoint-initdb.d/sql}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/docker-entrypoint-initdb.d/migrations}"
BACKUP_DIR="${BACKUP_DIR:-/docker-entrypoint-initdb.d/pg_backups}"

# --------------------------------------------
# Helper: apply a single migration file if it
# has not already been applied. Tracks state in
# the schema_migrations table so re-runs are safe.
# --------------------------------------------
apply_migration_file() {
  local file="$1"
  local version
  version=$(basename "$file")

  if psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
      "SELECT 1 FROM schema_migrations WHERE version = '$version'" | grep -q 1; then
    echo "Skipping already applied migration: $version"
    return 0
  fi

  echo "Applying migration: $version"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$file"
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
      "INSERT INTO schema_migrations (version) VALUES ('$version');"
}

# --------------------------------------------
# 🗄️ STEP 1: Attempt to restore latest backup
# --------------------------------------------

if [ -d "$BACKUP_DIR" ]; then
  LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/*.sql 2>/dev/null | head -n 1)
else
  LATEST_BACKUP=""
fi

if [ -f "$LATEST_BACKUP" ]; then
  echo "🗄️ Found latest backup: $LATEST_BACKUP"
  echo "⏳ Restoring from backup..."
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$LATEST_BACKUP"
  echo "✅ Backup restoration complete. Skipping schema and migrations."
  exit 0
else
  echo "ℹ️ No valid backup found. Proceeding with base schema and migrations."
fi

# --------------------------------------------
# 🏗️ STEP 2: Continue with base schema setup
# --------------------------------------------

# Create migrations table if it doesn't exist
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT now()
  );
"

# List of base schema files to execute in order
BASE_SQL_FILES=(
  "0_extensions.sql"
  "1_tables.sql"
  "indexes.sql"
  "4_functions.sql"
  "triggers.sql"
  "3_views.sql"
  "2_dml.sql"
  "5_database_user.sql"
)

echo "Running base schema SQL files in order..."

for file in "${BASE_SQL_FILES[@]}"; do
  full_path="$SQL_DIR/$file"
  if [ -f "$full_path" ]; then
    echo "Executing $file..."
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$full_path"
  else
    echo "WARNING: $file not found, skipping."
  fi
done

echo "✅ Base schema SQL execution complete."

# --------------------------------------------
# 🚀 STEP 3: Apply SQL migrations
#
# Ordering (important for dependency correctness):
#   a. import-tasks/ subdirectory  — data / structural migrations
#      that other migration sets depend on must go first.
#   b. Root-level *.sql files     — chronological (timestamp-prefixed).
#   c. release-* subdirectories   — version-ordered for upgrade paths.
# --------------------------------------------

echo "Applying migrations..."

# 3a. import-tasks/ migrations (must be first — other migrations reference
#     the import infrastructure tables/functions defined here).
if [ -d "$MIGRATIONS_DIR/import-tasks" ]; then
  echo "  → Applying import-tasks migrations..."
  for f in "$MIGRATIONS_DIR"/import-tasks/*.sql; do
    [ -e "$f" ] || continue
    apply_migration_file "$f"
  done
fi

# 3b. Root-level migration files (sorted alphabetically — they are
#     timestamp-prefixed so alphabetical == chronological).
if [ -d "$MIGRATIONS_DIR" ] && compgen -G "$MIGRATIONS_DIR/*.sql" > /dev/null 2>&1; then
  echo "  → Applying root-level migrations..."
  for f in "$MIGRATIONS_DIR"/*.sql; do
    [ -e "$f" ] || continue
    apply_migration_file "$f"
  done
fi

# 3c. release-* subdirectories (sorted by directory name so release
#     versions are applied in ascending order).
if [ -d "$MIGRATIONS_DIR" ]; then
  for dir in "$MIGRATIONS_DIR"/release-*; do
    [ -d "$dir" ] || continue
    echo "  → Applying migrations from $(basename "$dir")..."
    for f in "$dir"/*.sql; do
      [ -e "$f" ] || continue
      apply_migration_file "$f"
    done
  done
fi

echo "🎉 Database initialization completed successfully."
