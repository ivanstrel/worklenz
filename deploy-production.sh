# =====================================================
# Production Deployment Script for Worklenz
# =====================================================
# Usage:
#   ./deploy-production.sh [domain] [email]
#
# Example:
#   ./deploy-production.sh example.com admin@example.com
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - Let's Encrypt email address
#   - Domain name pointing to this server
#   - .env.production file configured
# =====================================================

#!/bin/bash
set -euo pipefail

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="${1:-${DOMAIN:-$(hostname -f)}}"
LETSENCRYPT_EMAIL="${2:-${LETSENCRYPT_EMAIL:-admin@${DOMAIN}}}"
PROJECT_NAME="worklenz"
APP_VERSION="${APP_VERSION:-latest}"

echo "========================================"
echo "  Worklenz Production Deployment"
echo "========================================"
echo "Domain: ${DOMAIN}"
echo "Email:  ${LETSENCRYPT_EMAIL}"
echo "Version: ${APP_VERSION}"
echo "========================================"

# --- Verify prerequisites ---
check_command() {
    if ! command -v "$1" &>/dev/null; then
        echo "ERROR: $1 is not installed. Please install it first."
        exit 1
    fi
}

check_command docker
check_command docker-compose

# --- Verify environment files ---
echo "[1/6] Checking environment files..."

if [ ! -f "$SCRIPT_DIR/.env.production" ]; then
    if [ -f "$SCRIPT_DIR/.env.production.example" ]; then
        echo "Creating .env.production from template..."
        cp "$SCRIPT_DIR/.env.production.example" "$SCRIPT_DIR/.env.production"
        echo "WARNING: Please edit .env.production with your production values before continuing."
        echo "   Run this script again after configuration."
        exit 1
    else
        echo "ERROR: No .env.production or .env.production.example found at $SCRIPT_DIR"
        exit 1
    fi
fi

if [ ! -f "$SCRIPT_DIR/worklenz-backend/.env.production" ]; then
    if [ -f "$SCRIPT_DIR/worklenz-backend/.env.template" ]; then
        cp "$SCRIPT_DIR/worklenz-backend/.env.template" "$SCRIPT_DIR/worklenz-backend/.env.production"
        echo "WARNING: Copy of .env.template created for backend. Please configure it."
    fi
fi

if [ ! -f "$SCRIPT_DIR/worklenz-frontend/.env.production" ]; then
    cp "$SCRIPT_DIR/worklenz-frontend/.env.production.example" "$SCRIPT_DIR/worklenz-frontend/.env.production"
    echo "WARNING: Copy of .env.production.example created for frontend. Please configure it."
fi

# --- Auto-configure environment ---
echo "[2/6] Auto-configuring environment variables..."
chmod +x "$SCRIPT_DIR/manage.sh" 2>/dev/null || true
if [ -f "$SCRIPT_DIR/manage.sh" ]; then
    source "$SCRIPT_DIR/manage.sh"
    auto_configure_env "$DOMAIN" "$LETSENCRYPT_EMAIL"
fi

# --- Pull latest images (optional) ---
echo "[3/6] Building production images..."
docker-compose -f "$SCRIPT_DIR/docker-compose.production.yml" build --no-cache

# --- Start containers ---
echo "[4/6] Starting production containers..."
docker-compose -f "$SCRIPT_DIR/docker-compose.production.yml" up -d

# --- Wait for services to be ready ---
echo "[5/6] Waiting for services to be healthy..."
sleep 10

# Check database health
if docker-compose -f "$SCRIPT_DIR/docker-compose.production.yml" exec -T db pg_isready -d "${DB_NAME:-worklenz_db}" -U "${DB_USER:-postgres}" >/dev/null 2>&1; then
    echo "  ✓ Database is ready"
else
    echo "  ⚠ Database not ready yet, waiting..."
    sleep 15
fi

# Check backend health
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "  ✓ Backend is healthy"
else
    echo "  ⚠ Backend health check returned $HTTP_CODE"
fi

# --- Print summary ---
echo "[6/6] Deployment summary..."
echo ""
echo "========================================"
echo "  Deployment Complete!"
echo "========================================"
echo "Frontend:  http://${DOMAIN}"
echo "Backend:   http://${DOMAIN}/api"
echo "Database:  PostgreSQL (internal)"
echo "Storage:   MinIO (internal)"
echo ""
echo "Next steps:"
echo "  1. Configure nginx reverse proxy using nginx-production/worklenz.conf"
echo "  2. Set up Let's Encrypt SSL certificates"
echo "  3. Configure DNS records for ${DOMAIN}"
echo "  4. Review environment variables in .env.production files"
echo ""
echo "Logs:"
echo "  docker-compose -f docker-compose.production.yml logs -f"
echo ""
echo "To stop:"
echo "  docker-compose -f docker-compose.production.yml down"
echo "========================================"

# --- Verify Keycloak configuration ---
if [ -n "${KEYCLOAK_CLIENT_ID:-}" ] && [ "$KEYCLOAK_CLIENT_ID" != "your_keycloak_client_id" ]; then
    echo ""
    echo "✓ Keycloak authentication is configured"
else
    echo ""
    echo "ℹ Keycloak authentication is not configured (KEYCLOAK_CLIENT_ID not set)"
    echo "  See .env.template for Keycloak configuration options"
fi

exit 0
