# Worklenz Production Deployment Guide

This guide covers deploying Worklenz in a production environment using Docker Compose, with optional Keycloak OpenID Connect SSO.

## Prerequisites

- Server with Docker and Docker Compose installed
- Domain name with DNS pointing to your server
- SSL certificate (Let's Encrypt or custom)
- PostgreSQL 15+ (or use the bundled container)
- Redis (or use the bundled container)

## Quick Start

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd worklenz

# 2. Copy environment files
cp .env.production.example .env.production
cp worklenz-backend/.env.template worklenz-backend/.env.production
cp worklenz-frontend/.env.production.example worklenz-frontend/.env.production

# 3. Edit the environment files with your production values
#    Set DOMAIN, DB_PASSWORD, SESSION_SECRET, JWT_SECRET, etc.

# 4. Deploy
chmod +x deploy-production.sh
./deploy-production.sh your-domain.com admin@your-domain.com
```

## Keycloak OpenID Connect Configuration

Worklenz supports Keycloak as an OpenID Connect identity provider for Single Sign-On (SSO).

### Configure Keycloak

1. In your Keycloak admin console:
   - Create a new realm or use an existing one
   - Create a new client with:
     - Client ID: `worklenz` (or your preferred ID)
     - Client Protocol: `openid-connect`
     - Access Type: `confidential`
   - Note the client ID and client secret
   - Set Valid Redirect URIs to include:
     - `https://your-domain.com/api/auth/keycloak`
     - `https://your-domain.com/api/auth/keycloak/verify`
   - Set Web Origins to your domain

2. Get the realm configuration values:
   - **Issuer**: `https://your-keycloak-server/realms/your-realm`
   - **Authorization URL**: `https://your-keycloak-server/realms/your-realm/protocol/openid-connect/auth`
   - **Token URL**: `https://your-keycloak-server/realms/your-realm/protocol/openid-connect/token`
   - **UserInfo URL**: `https://your-keycloak-server/realms/your-realm/protocol/openid-connect/userinfo`

3. Add these to your `.env.production` file:

```env
KEYCLOAK_CLIENT_ID=your-keycloak-client-id
KEYCLOAK_CLIENT_SECRET=your-keycloak-client-secret
KEYCLOAK_ISSUER=https://your-keycloak-server/realms/your-realm
KEYCLOAK_AUTHORIZATION_URL=https://your-keycloak-server/realms/your-realm/protocol/openid-connect/auth
KEYCLOAK_TOKEN_URL=https://your-keycloak-server/realms/your-realm/protocol/openid-connect/token
KEYCLOAK_USERINFO_URL=https://your-keycloak-server/realms/your-realm/protocol/openid-connect/userinfo
KEYCLOAK_CALLBACK_URL=https://your-domain.com/api/auth/keycloak/verify
```

### Frontend Configuration

To show the "Sign in with Keycloak" button on the frontend, set:

```env
# In worklenz-frontend/.env.production
VITE_ENABLE_KEYCLOAK_LOGIN=true
```

### Keycloak User Data Handling

When a user logs in via Keycloak:
1. The `keycloak_id` (OpenID Connect `sub` claim) is stored in the `users` table
2. If the user doesn't exist, a new account is created via the `register_keycloak_user()` database function
3. The `is_keycloak` flag is set in the user session (preventing password reset flows)
4. Keycloak users are hidden from the password change settings page

### Important Notes

- **Invitation flow**: Unlike Google/Apple OAuth, Keycloak uses `passport-openidconnect` which stores invitation data in the session rather than passing it via URL query state parameters.
- **CSRF protection**: Keycloak OAuth routes (`/api/auth/keycloak*`) are exempt from CSRF protection.
- **Database migrations**: The `keycloak_id` column is added via migration files `20251112000003` and `20251112000004`, which are idempotent.

## Environment Variables Reference

### Backend (.env.production)

| Variable | Description | Required |
|----------|-------------|----------|
| `DB_HOST` | Database host | Yes |
| `DB_NAME` | Database name | Yes |
| `DB_USER` | Database user | Yes |
| `DB_PASSWORD` | Database password | Yes |
| `SESSION_SECRET` | Session encryption secret | Yes |
| `JWT_SECRET` | JWT token secret | Yes |
| `KEYCLOAK_CLIENT_ID` | Keycloak client ID | No |
| `KEYCLOAK_CLIENT_SECRET` | Keycloak client secret | No |
| `KEYCLOAK_ISSUER` | Keycloak issuer URL | No |
| `KEYCLOAK_AUTHORIZATION_URL` | Keycloak auth URL | No |
| `KEYCLOAK_TOKEN_URL` | Keycloak token URL | No |
| `KEYCLOAK_USERINFO_URL` | Keycloak userinfo URL | No |
| `KEYCLOAK_CALLBACK_URL` | Keycloak callback URL | No |

### Frontend (worklenz-frontend/.env.production)

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_ENABLE_KEYCLOAK_LOGIN` | Enable Keycloak login button | `false` |
| `VITE_ENABLE_GOOGLE_LOGIN` | Enable Google login button | `false` |
| `VITE_ENABLE_APPLE_LOGIN` | Enable Apple login button | `false` |

## SSL/TLS Configuration

The `nginx-production/worklenz.conf` file provides a complete nginx configuration with:
- HTTP → HTTPS redirect
- SSL with Let's Encrypt certificates
- Security headers (HSTS, X-Frame-Options, etc.)
- Gzip compression
- WebSocket proxy support
- Static file caching

## Troubleshooting

### Keycloak login fails
- Verify all `KEYCLOAK_*` environment variables are set
- Check the Keycloak client redirect URLs match your domain
- Ensure `KEYCLOAK_CALLBACK_URL` matches what's configured in Keycloak

### CSRF token errors
- Keycloak OAuth routes are exempt from CSRF protection
- Ensure you're not manually applying CSRF to `/api/auth/keycloak*` routes

### Database migration errors
- The `keycloak_id` column migration is idempotent (uses `IF NOT EXISTS`)
- Check `schema_migrations` table for applied migration names
