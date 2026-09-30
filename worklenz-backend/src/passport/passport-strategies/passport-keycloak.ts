import { Strategy as OpenIDConnectStrategy, OpenIDConnectProfile } from "passport-openidconnect";
import { sendWelcomeEmail } from "../../shared/email-templates";
import { log_error } from "../../shared/utils";
import db from "../../config/db";
import { ERROR_KEY } from "./passport-constants";
import { Request } from "express";

// Verbose OAuth error dumps (full error objects + stack traces) are opt-in so
// they don't flood production logs. log_error always still records the error.
const AUTH_DEBUG = /^(1|true)$/i.test(process.env.AUTH_DEBUG || "");

async function handleKeycloakLogin(req: Request, _issuer: string, profile: OpenIDConnectProfile, done: any) {
  try {
    const body: any = profile;
    if (Array.isArray(profile.emails) && profile.emails.length) body.email = profile.emails[0].value;
    if (Array.isArray(profile.photos) && profile.photos.length) body.picture = profile.photos[0].value;

    // If the user came from an invitation, retrieve data from session.
    // passport-openidconnect stores the `state` option in the session via its
    // own SessionStateStore and does NOT expose it as req.query.state in the
    // callback (unlike passport-google-oauth20). We store invitation data
    // directly in req.session in the route handler.
    const state = (req.session as any).keycloakInvitationData || {};
    if (state) {
      body.team = state.team;
      body.member_id = state.teamMember;
    }
    // Clean up invitation data from session after reading
    delete (req.session as any).keycloakInvitationData;

    // Only trust the email claim for account matching/linking when the IdP
    // asserts it as verified. Linking a Keycloak identity onto a pre-existing
    // account based solely on an unverified email would allow account takeover
    // in any realm that permits self-registration or does not enforce email
    // verification. Unverified identities may still sign in or register by
    // their stable `sub` (keycloak_id), never by email.
    const emailVerified = (profile as any)?._json?.email_verified === true;

    const q1 = `SELECT id, keycloak_id, name, email, active_team
                FROM users
                WHERE (keycloak_id = $1 OR ($2::boolean AND email = $3))
                  AND is_deleted = FALSE;`;
    const result1 = await db.query(q1, [body.id, emailVerified, body.email]);

    if (result1.rowCount) { // Login
      const [user] = result1.rows;

      // Link Keycloak account if user signed up with email/password but keycloak_id is not set
      if (!user.keycloak_id && body.id) {
        try {
          await db.query("UPDATE users SET keycloak_id = $1 WHERE id = $2;", [body.id, user.id]);
          user.keycloak_id = body.id;
        } catch (error) {
          log_error(error, user);
        }
      }

      // Update active team of users who came from an invitation
      try {
        await db.query("SELECT set_active_team($1, $2);", [user.id || null, state.team || null]);
      } catch (error) {
        log_error(error, user);
      }

      if (user)
        return done(null, user);

      return done(null, false, { message: "User not found" });
    }

    // Reactivating a soft-deleted account and linking a Keycloak identity onto
    // it is the same trust decision as the email match above, so require a
    // verified email.
    if (emailVerified) {
      const deletedCheck = await db.query(
        "SELECT id, email FROM users WHERE LOWER(email) = LOWER($1) AND is_deleted = TRUE;",
        [body.email]
      );

      if (deletedCheck.rowCount) {
        // Reactivate the soft-deleted account and link Keycloak ID
        const [deletedUser] = deletedCheck.rows;
        await db.query(
          "UPDATE users SET is_deleted = FALSE, keycloak_id = $1, name = COALESCE($2, name) WHERE id = $3;",
          [body.id, body.displayName, deletedUser.id]
        );

        // Update active team if from invitation
        try {
          await db.query("SELECT set_active_team($1, $2);", [deletedUser.id, state.team || null]);
        } catch (error) {
          log_error(error);
        }

        return done(null, { id: deletedUser.id, email: deletedUser.email, keycloak_id: body.id });
      }
    }

    // Register a brand-new user keyed by the Keycloak `sub`. If another account
    // already owns this email but the identity's email was not verified (so it
    // could not be matched above), the unique constraint on email fires here —
    // refuse the login rather than link or duplicate. That is the secure outcome.
    let result2;
    try {
      result2 = await db.query(`SELECT register_keycloak_user($1) AS user;`, [JSON.stringify(body)]);
    } catch (regError: any) {
      if (regError?.code === "23505") {
        log_error("Keycloak registration blocked: email already in use and not verified", body.email);
        return done(null, false, { message: "Email already registered with another sign-in method" });
      }
      throw regError;
    }
    const [data] = result2.rows;

    sendWelcomeEmail(data.user.email, body.displayName);
    return done(null, data.user, { message: "User successfully logged in" });
  } catch (error: any) {
    if (AUTH_DEBUG) {
      console.error("[Keycloak OAuth] handleKeycloakLogin CAUGHT ERROR:");
      console.error("[Keycloak OAuth] error:", error);
      console.error("[Keycloak OAuth] message:", error?.message);
      console.error("[Keycloak OAuth] code:", error?.code);
      console.error("[Keycloak OAuth] stack:", error?.stack);
    }
    log_error(error);
    return done(error);
  }
}

/**
 * Passport strategy for authenticate with Keycloak via OpenID Connect
 * https://github.com/jaredhanson/passport-openidconnect
 */

const isKeycloakConfigured = () => {
  return !!(
    process.env.KEYCLOAK_ISSUER &&
    process.env.KEYCLOAK_AUTHORIZATION_URL &&
    process.env.KEYCLOAK_TOKEN_URL &&
    process.env.KEYCLOAK_CLIENT_ID &&
    process.env.KEYCLOAK_CLIENT_SECRET &&
    process.env.KEYCLOAK_CALLBACK_URL
  );
};

// Only create strategy if Keycloak is configured
let keycloakStrategy: any = null;

if (isKeycloakConfigured()) {
  keycloakStrategy = new OpenIDConnectStrategy({
    issuer: process.env.KEYCLOAK_ISSUER as string,
    authorizationURL: process.env.KEYCLOAK_AUTHORIZATION_URL as string,
    tokenURL: process.env.KEYCLOAK_TOKEN_URL as string,
    userInfoURL: process.env.KEYCLOAK_USERINFO_URL as string,
    clientID: process.env.KEYCLOAK_CLIENT_ID as string,
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET as string,
    callbackURL: process.env.KEYCLOAK_CALLBACK_URL as string,
    // Scope is passed in passport.authenticate() call, not here, to avoid
    // duplication ("openid openid email profile").
    passReqToCallback: true,
    // By default, passport-openidconnect parses the profile from the ID token
    // and does NOT call the UserInfo endpoint (skipUserProfile returns true
    // when verify.length < 10). This is sufficient for Keycloak since the ID
    // token contains all necessary claims (sub, email, name, etc.).
    // Set skipUserProfile: false if you need the UserInfo endpoint to be called.
  },
    (req, issuer, profile, done) => void handleKeycloakLogin(req, issuer, profile, done));
} else {
  console.warn(
    "⚠️  Keycloak Sign-In is not configured. Set KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, and KEYCLOAK_CALLBACK_URL in .env to enable it.",
  );
}

export default keycloakStrategy;
