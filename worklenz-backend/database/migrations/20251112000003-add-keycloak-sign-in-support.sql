-- =====================================================
-- Migration: Add Keycloak Sign-In Support to Worklenz
-- Date: 2025-11-12
-- Description: Adds keycloak_id column to users table for Keycloak OpenID Connect authentication
-- Author: Worklenz Development Team
-- =====================================================

-- Add keycloak_id column to users table
-- This column stores Keycloak's unique user identifier (sub claim from ID token)
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS keycloak_id TEXT;

-- Create index for keycloak_id lookups (performance optimization)
-- This index improves query performance when looking up users by keycloak_id
CREATE INDEX IF NOT EXISTS idx_users_keycloak_id ON users(keycloak_id);

-- Add comment for documentation
COMMENT ON COLUMN users.keycloak_id IS 'Keycloak unique user identifier (sub claim from ID token). Used for Keycloak OpenID Connect OAuth authentication.';

-- Verify the column was added successfully
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'users'
        AND column_name = 'keycloak_id'
    ) THEN
        RAISE NOTICE '✓ keycloak_id column successfully added to users table';
    ELSE
        RAISE EXCEPTION '✗ Failed to add keycloak_id column to users table';
    END IF;
END $$;

-- Verify the index was created successfully
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE tablename = 'users'
        AND indexname = 'idx_users_keycloak_id'
    ) THEN
        RAISE NOTICE '✓ Index idx_users_keycloak_id successfully created';
    ELSE
        RAISE EXCEPTION '✗ Failed to create index idx_users_keycloak_id';
    END IF;
END $$;

-- =====================================================
-- Rollback Instructions (if needed):
-- =====================================================
-- To rollback this migration, run:
-- DROP INDEX IF EXISTS idx_users_keycloak_id;
-- ALTER TABLE users DROP COLUMN IF EXISTS keycloak_id;
--
-- WARNING: Only rollback if no users have signed in with Keycloak yet!
-- =====================================================
