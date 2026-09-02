# Keycloak Integration — Supportive Information

This document provides quick-reference information for the Keycloak OpenID Connect
SSO integration in Worklenz. See `keycloack_instructions.md` in this directory
for the full implementation notes.

## Architecture Overview

Worklenz supports three OAuth providers for user authentication:

| Provider | Package | Env Toggle | Strategy Name |
|----------|---------|------------|---------------|
| Google | `passport-google-oauth20` | `VITE_ENABLE_GOOGLE_LOGIN` | `GoogleStrategy` |
| Apple (Web) | `passport-apple` | `VITE_ENABLE_APPLE_LOGIN` | `AppleStrategy` |
| **Keycloak** | `passport-openidconnect` | `VITE_ENABLE_KEYCLOAK_LOGIN` | `OpenIDConnectStrategy` |

All three providers follow the same **conditional strategy pattern**: the Passport
strategy is only instantiated at module-load time if its environment variables are
present. This allows the app to run without any OAuth provider configured.

### Conditional Strategy Pattern

```typescript
// passport-keycloak.ts (and passport-google.ts, passport-apple-web.ts)
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

let keycloakStrategy: any = null;

if (isKeycloakConfigured()) {
  keycloakStrategy = new OpenIDConnectStrategy({...}, verify);
}

export default keycloakStrategy;
```

In `passport/index.ts`, strategies are registered conditionally:

```typescript
if (KeycloakLogin) {
  passport.use("keycloak", KeycloakLogin);
}
```

## Key Differentiator: Session-based Invitation Data

Unlike `passport-google-oauth20`, the `passport-openidconnect` package manages
its own `state` parameter internally (generating a random handle and storing
`appState` in the session). This means the JSON invitation data passed via URL
query params (`team`, `teamMember`, `project`) is **not** available as
`req.query.state` in the callback.

### Solution

Invitation data is stored **directly in `req.session`** before the OAuth redirect:

```typescript
// routes/auth/index.ts
authRouter.get("/keycloak", (req, res, next) => {
  (req.session as any).keycloakInvitationData = {
    teamMember: req.query.teamMember || null,
    team: req.query.team || null,
    teamName: req.query.teamName || null,
    project: req.query.project || null
  };
  return passport.authenticate("keycloak", {
    scope: ["openid", "email", "profile"]
  })(req, res, next);
});
```

In the strategy's verify callback, this data is read and then cleaned up:

```typescript
// passport-keycloak.ts → handleKeycloakLogin()
const state = (req.session as any).keycloakInvitationData || {};
delete (req.session as any).keycloakInvitationData;
```

## File Inventory

### New Files Created

| File | Purpose |
|------|---------|
| `worklenz-backend/src/passport/passport-strategies/passport-keycloak.ts` | Keycloak OIDC Passport strategy |
| `worklenz-backend/src/passport/passport-strategies/passport-openidconnect.d.ts` | TypeScript type declarations for `passport-openidconnect` |
| `worklenz-backend/src/ee/business.ts` | EE business module stub (re-exports CE business) |
| `worklenz-backend/src/ce/business.ts` | CE business module stub |
| `worklenz-backend/database/migrations/20251112000003-add-keycloak-sign-in-support.sql` | Adds `keycloak_id` column + index |
| `worklenz-backend/database/migrations/20251112000004-add-register-keycloak-user-function.sql` | Creates `register_keycloak_user(json)` DB function |

### Modified Files

| File | Change |
|------|--------|
| `worklenz-backend/src/app.ts` | Added 4 Keycloak paths to CSRF `authPaths` array |
| `worklenz-backend/src/passport/index.ts` | Import `KeycloakLogin`, wrap `GoogleLogin` in conditional, add conditional Keycloak registration |
| `worklenz-frontend/src/passport/passport-strategies/passport-google.ts` | Made conditional (returns `null` if not configured) |
| `worklenz-backend/src/routes/auth/index.ts` | Added `/keycloak` and `/keycloak/verify` routes with session-based invitation data |
| `worklenz-backend/src/controllers/account-deletion-controller.ts` | Added `keycloak_id` to user SELECT query and Teams webhook |
| `worklenz-backend/src/controllers/auth-controller.ts` | Added `keycloak_id` to password reset query and OAuth check |
| `worklenz-backend/database/sql/1_tables.sql` | Added `keycloak_id TEXT` column to `users` table |
| `worklenz-backend/database/sql/4_functions.sql` | Added `is_keycloak` to `deserialize_user` function |
| `worklenz-backend/src/controllers/deserialize.sql.sql` | Added `is_keycloak` to inline SQL |
| `worklenz-backend/database/sql/triggers.sql` | Fixed `task_priorities` → `sys_project_priorities` |
| `worklenz-backend/.env.template` | Added Keycloak env vars, fixed callback URLs to port 3000 |
| `update-docker-env.sh` | Added `KEYCLOAK_CALLBACK_URL`, fixed Google/Apple callbacks to port 3000 |
| `manage.sh` | Added `KEYCLOAK_CALLBACK_URL` sed lines in `auto_configure_env` |
| `worklenz-frontend/package.json` | (no, backend) Added `passport-openidconnect` dependency |
| `worklenz-frontend/src/shared/worklenz-analytics-events.ts` | Added `evt_login_with_keycloak_click` and `evt_signup_with_keycloak_click` |
| `worklenz-frontend/src/types/auth/local-session.types.ts` | Added `is_keycloak?: boolean` |
| `worklenz-frontend/src/pages/auth/LoginPage.tsx` | Added Keycloak toggle, handler, button |
| `worklenz-frontend/src/pages/auth/SignupPage.tsx` | Added Keycloak toggle, handler, button |
| `worklenz-frontend/src/pages/auth/ForgotPasswordPage.tsx` | Fixed Google URL, added Keycloak button + handler |
| `worklenz-frontend/src/pages/settings/sidebar/settings-sidebar.tsx` | Hide change-password for keycloak users |

### Modified Locale Files (18 files)

Added `signInWithKeycloakButton` to:
- `public/locales/{en,alb,de,es,pt,zh}/auth/login.json`
- `public/locales/{en,alb,de,es,pt,zh}/auth/signup.json`
- `public/locales/{en,alb,de,es,pt,zh}/auth/forgot-password.json`

### Environment Variable Template Files

| File | Description |
|------|-------------|
| `worklenz-frontend/.env.example` | Added `VITE_ENABLE_KEYCLOAK_LOGIN=false` |
| `worklenz-frontend/.env.production.example` | Created with production values |
| `.env.production.example` (root) | Created with full production env reference |

### Production & Deployment Files

| File | Description |
|------|-------------|
| `docker-compose.production.yml` | Production Docker Compose with Redis |
| `deploy-production.sh` | One-command production deployment script |
| `nginx-production/worklenz.conf` | Nginx reverse proxy with SSL + security headers |
| `PRODUCTION_DEPLOYMENT.md` | Full deployment guide |

## Environment Variables

### Backend `.env`

```env
# Keycloak OpenID Connect
KEYCLOAK_CLIENT_ID=your_keycloak_client_id
KEYCLOAK_CLIENT_SECRET=your_keycloak_client_secret
KEYCLOAK_ISSUER=https://your-keycloak-server/realms/your-realm
KEYCLOAK_AUTHORIZATION_URL=https://your-keycloak-server/realms/your-realm/protocol/openid-connect/auth
KEYCLOAK_TOKEN_URL=https://your-keycloak-server/realms/your-realm/protocol/openid-connect/token
KEYCLOAK_USERINFO_URL=https://your-keycloak-server/realms/your-realm/protocol/openid-connect/userinfo
KEYCLOAK_CALLBACK_URL=http://localhost:3000/secure/keycloak/verify
```

### Frontend `.env`

```env
VITE_ENABLE_KEYCLOAK_LOGIN=true
```

## Database Schema

### Column Added to `users` table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `keycloak_id` | `TEXT` | `NULL` | Keycloak unique user identifier (sub claim from ID token) |

### Migration Order

Migrations are applied alphabetically after the base schema:

1. `20251112000001-add-apple-sign-in-support.sql` (existing — Apple)
2. `20251112000002-add-apple-sign-in-support.sql` (existing — Apple, alternate)
3. `20251112000003-add-keycloak-sign-in-support.sql` (new — adds `keycloak_id` column)
4. `20251112000004-add-register-keycloak-user-function.sql` (new — creates `register_keycloak_user()` function)

### `is_keycloak` in `deserialize_user`

The `deserialize_user` function in `4_functions.sql` and `deserialize.sql.sql`
now includes:

```sql
(is_null_or_empty(u.keycloak_id) IS FALSE) AS is_keycloak,
```

This flag is used by the frontend to hide password-related features for
Keycloak-authenticated users.

## OAuth Flow

```
1. User clicks "Sign in with Keycloak" on frontend
   → Redirect to {VITE_API_URL}/secure/keycloak?team=...&teamMember=...&project=...

2. Backend stores invitation data in req.session.keycloakInvitationData
   → Calls passport.authenticate("keycloak", { scope: ["openid", "email", "profile"] })
   → Redirects to Keycloak authorization endpoint

3. User authenticates on Keycloak
   → Keycloak redirects back to {KEYCLOAK_CALLBACK_URL} (e.g., /secure/keycloak/verify)

4. Backend strategy verify callback:
   - Reads keycloakInvitationData from session
   - Looks up user by keycloak_id or email
   - If exists: link keycloak_id, set active team, log in
   - If doesn't exist: call register_keycloak_user() DB function
   - Cleans up session invitation data

5. On success: redirect to LOGIN_SUCCESS_REDIRECT
   On failure: redirect to LOGIN_FAILURE_REDIRECT
```

## Frontend Integration Points

### LoginPage (`src/pages/auth/LoginPage.tsx`)

```typescript
const enableKeycloakLogin = import.meta.env.VITE_ENABLE_KEYCLOAK_LOGIN === 'true' || false;

const handleKeycloakLogin = useCallback(() => {
  trackMixpanelEvent(evt_login_with_keycloak_click);
  const url = `${import.meta.env.VITE_API_URL}/secure/keycloak`;
  window.location.href = url;
}, [trackMixpanelEvent]);
```

Button:
```jsx
{enableKeycloakLogin && (
  <Button block type="default" size="large" onClick={handleKeycloakLogin}>
    {t('signInWithKeycloakButton', { defaultValue: 'Sign in with Keycloak' })}
  </Button>
)}
```

### SignupPage (`src/pages/auth/SignupPage.tsx`)

Same pattern as LoginPage, but redirects from `/secure/keycloak` and uses
`evt_signup_with_keycloak_click` analytics event.

### ForgotPasswordPage (`src/pages/auth/ForgotPasswordPage.tsx`)

- Fixed Google sign-in URL from `/api/auth/google` to `${VITE_API_URL}/secure/google`
- Added `enableKeycloakLogin` toggle
- Added `handleKeycloakSignIn` handler
- Added Keycloak button to the OAuth user Result component

### Settings Sidebar (`src/pages/settings/sidebar/settings-sidebar.tsx`)

```typescript
.filter(item => !(currentSession?.is_keycloak && item.key === 'change-password'))
```

Keycloak users don't have a password, so the "Change Password" settings item
is hidden.

## CSRF Protection

Keycloak OAuth routes are exempt from CSRF protection. The CSRF middleware in
`app.ts` checks the `authPaths` array:

```typescript
const authPaths = [
  "/api/auth/google",
  "/api/auth/google/callback",
  "/secure/google",
  "/secure/google/verify",
  "/api/auth/apple",
  "/api/auth/apple/callback",
  "/secure/apple",
  "/secure/apple/verify",
  "/keycloak",
  "/secure/keycloak",
  "/keycloak/verify",
  "/secure/keycloak/verify",
];
```

## Testing Checklist

- [ ] Keycloak strategy loads conditionally (null if env vars not set)
- [ ] `passport/index.ts` registers Keycloak strategy only if not null
- [ ] CSRF exemption works for `/secure/keycloak*` routes
- [ ] `keycloak_id` column added to `users` table
- [ ] `is_keycloak` flag appears in deserialized user session
- [ ] `register_keycloak_user()` function creates new users correctly
- [ ] Existing Google/Apple login still works (passport-google.ts now conditional)
- [ ] Account deletion query includes `keycloak_id`
- [ ] Password reset skips OAuth users (including Keycloak)
- [ ] Settings sidebar hides "Change Password" for Keycloak users
- [ ] All locale files have `signInWithKeycloakButton` translation
- [ ] Migration ordering: 0003 before 0004, both after Apple 0001/0002
