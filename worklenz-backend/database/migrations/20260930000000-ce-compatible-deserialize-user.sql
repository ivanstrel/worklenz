-- =====================================================
-- Migration: Make deserialize_user CE-compatible (+ has_password)
-- Date: 2026-09-30
-- Description: Recreates deserialize_user for the Community Edition schema.
--
-- The CE-compatible rewrite was originally made only in database/sql/4_functions.sql,
-- which is part of the base-schema bootstrap and therefore only runs when the
-- Postgres data directory is empty. Already-provisioned databases kept the old
-- function that referenced Enterprise-only tables/columns (business_plan_override,
-- team_member_limit_override, licensing_plan_trials, licensing_plan_tiers) that do
-- not exist in the CE schema, causing deserialize_user to fail at runtime on every
-- authenticated request. This migration applies the same definition to those DBs.
--
-- It also adds `has_password` so the client can distinguish "Keycloak-only" users
-- (no local password) from accounts that merely linked Keycloak onto an existing
-- email/password login.
--
-- CREATE OR REPLACE makes this idempotent and safe to re-run.
-- =====================================================

CREATE OR REPLACE FUNCTION deserialize_user(_id uuid) returns json
    language plpgsql
as
$$
DECLARE
    _result JSON;
BEGIN
    WITH user_team_data AS (SELECT u.id,
                                   u.name,
                                   u.email,
                                   u.timezone_id                                                 AS timezone,
                                   u.avatar_url,
                                   u.user_no,
                                   u.socket_id,
                                   u.created_at                                                  AS joined_date,
                                   u.updated_at                                                  AS last_updated,
                                   u.setup_completed                                             AS my_setup_completed,
                                   u.mobile_app_banner_dismissed,
                                   (is_null_or_empty(u.google_id) IS FALSE)                      AS is_google,
                                   (is_null_or_empty(u.keycloak_id) IS FALSE)                     AS is_keycloak,
                                   (is_null_or_empty(u.password) IS FALSE)                        AS has_password,
                                   COALESCE(u.active_team,
                                            (SELECT id FROM teams WHERE user_id = u.id LIMIT 1)) AS team_id,
                                   u.active_team,
                                   u.language
                            FROM users u
                            WHERE u.id = _id),
         team_org_data AS (SELECT utd.*,
                                  t.name    AS team_name,
                                  t.user_id AS owner_id,
                                  o.subscription_status,
                                  o.license_type_id,
                                  o.trial_expire_date,
                                  o.id      AS organization_id
                           FROM user_team_data utd
                                    INNER JOIN teams t ON t.id = utd.team_id
                                    LEFT JOIN organizations o ON o.user_id = t.user_id),
         appsumo_data AS (SELECT tod.owner_id,
                                 FALSE AS is_ltd,
                                 0     AS redeemed_codes_count,
                                 FALSE AS appsumo_business_eligible
                          FROM team_org_data tod),
         notification_data AS (SELECT tod.*,
                                      FALSE AS is_plan_trial,
                                      NULL::DATE AS plan_trial_end_date,
                                      NULL::INTEGER AS trial_days_remaining,
                                      NULL::TEXT AS active_plan_trial,
                                      NULL::TEXT AS trial_plan_display_name,
                                      ad.redeemed_codes_count,
                                      (ad.is_ltd AND ad.appsumo_business_eligible)   AS appsumo_business_eligible,
                                      COALESCE(ns.email_notifications_enabled, TRUE) AS email_notifications_enabled
                               FROM team_org_data tod
                                        LEFT JOIN appsumo_data ad ON TRUE
                                        LEFT JOIN notification_settings ns
                                                  ON (ns.user_id = tod.id AND ns.team_id = tod.team_id)),
         alerts_data AS (SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(ROW_TO_JSON(alert_rec))), '[]'::JSON) AS alerts
                         FROM (SELECT description, type
                               FROM worklenz_alerts
                               WHERE active IS TRUE) alert_rec),
         complete_user_data AS (SELECT nd.*,
                                       tz.name                                                             AS timezone_name,
                                       (SELECT r.name FROM roles r WHERE r.id = tm.role_id)                AS role_name,
                                       'COMMUNITY'                                                         AS subscription_type,
                                       'Community Edition'                                                 AS plan_name,
                                       tm.id                                                               AS team_member_id,
                                       ad.alerts,
                                       nd.active_plan_trial,
                                       nd.plan_trial_end_date,
                                       nd.trial_days_remaining,
                                       nd.trial_plan_display_name,
                                       nd.is_plan_trial,
                                       CASE
                                           WHEN nd.subscription_status = 'trialing' THEN nd.trial_expire_date::DATE
                                           ELSE NULL
                                           END                                                             AS valid_till_date,
                                       CASE
                                           WHEN is_owner(nd.id, nd.active_team) THEN nd.my_setup_completed
                                           ELSE TRUE
                                           END                                                             AS setup_completed,
                                       is_owner(nd.id, nd.active_team)                                     AS owner,
                                       is_admin(nd.id, nd.active_team)                                     AS is_admin
                                FROM notification_data nd
                                         CROSS JOIN alerts_data ad
                                         LEFT JOIN timezones tz ON tz.id = nd.timezone
                                         LEFT JOIN team_members tm
                                                   ON (tm.user_id = nd.id AND tm.team_id = nd.team_id AND tm.active IS TRUE))
    SELECT ROW_TO_JSON(complete_user_data.*)
    INTO _result
    FROM complete_user_data;

    INSERT INTO notification_settings (user_id, team_id, email_notifications_enabled, popup_notifications_enabled,
                                       show_unread_items_count)
    SELECT _id,
           COALESCE((SELECT active_team FROM users WHERE id = _id),
                    (SELECT id FROM teams WHERE user_id = _id LIMIT 1)),
           TRUE,
           TRUE,
           TRUE
    ON CONFLICT (user_id, team_id) DO NOTHING;

    RETURN _result;
END
$$;

COMMENT ON FUNCTION deserialize_user(uuid) IS 'Returns user session data for the Community Edition, including is_keycloak and has_password flags.';
