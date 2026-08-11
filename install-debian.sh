#!/bin/sh
#
# LAN install on a fresh Debian server. Installs Docker if needed,
# generates the stack's secrets and brings up
# docker-compose.selfhost.yml: the app, its cron sidecar and the five
# Supabase services it uses, behind nginx on a single origin.
#
#   ./install-debian.sh <lan-ip>   install, or update an existing install
#   ./install-debian.sh lock       close signups after the first account
#
# Runs as a regular user; sudo is only used to install missing packages
# (and for Docker itself if your user is not in the docker group).
# Safe to re-run: an existing .env is left alone and the migrate service
# only applies migrations it has not applied before.

set -eu

REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

SUDO=''
[ "$(id -u)" = 0 ] || SUDO='sudo'

fail() {
    echo "Error: $1" >&2
    exit 1
}

compose() {
    if [ -n "$DOCKER_SUDO" ]; then
        sudo docker compose -f "$REPO_DIR/docker-compose.selfhost.yml" "$@"
    else
        docker compose -f "$REPO_DIR/docker-compose.selfhost.yml" "$@"
    fi
}

# Sets DOCKER_SUDO to 'sudo' if that is the only way to reach Docker.
ensure_docker() {
    docker compose version >/dev/null 2>&1 || fail 'docker compose v2 is required'
    if docker info >/dev/null 2>&1; then
        DOCKER_SUDO=''
    elif [ -n "$SUDO" ] && sudo docker info >/dev/null 2>&1; then
        DOCKER_SUDO='sudo'
        echo "Note: using sudo for Docker. To avoid it, add yourself to the"
        echo "docker group and log in again: sudo usermod -aG docker $(id -un)"
    else
        fail 'cannot talk to Docker'
    fi
}

b64url() {
    openssl enc -base64 -A | tr '+/' '-_' | tr -d '='
}

# HS256 JWT signed with $jwt_secret, same shape as Supabase's own keys.
jwt() {
    header=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
    body=$(printf '%s' "$1" | b64url)
    sig=$(printf '%s' "$header.$body" | openssl dgst -binary -sha256 -hmac "$jwt_secret" | b64url)
    printf '%s' "$header.$body.$sig"
}

# When run standalone (downloaded straight from GitHub), fetch or update
# the repo and hand over to its copy of this script. The running file is
# outside the repo, so the pull cannot change it mid-flight.
if [ ! -f "$REPO_DIR/docker-compose.selfhost.yml" ]; then
    command -v git >/dev/null 2>&1 || { $SUDO apt update; $SUDO apt install -y git; }
    if [ -d "$HOME/firmabok/.git" ]; then
        git -C "$HOME/firmabok" pull --ff-only
    else
        git clone https://github.com/mews-se/firmabok.git "$HOME/firmabok"
    fi
    exec sh "$HOME/firmabok/install-debian.sh" "$@"
fi

case "${1:-}" in
    lock)
        ensure_docker
        sed -i 's|^AUTH_SIGNUPS_DISABLED=.*|AUTH_SIGNUPS_DISABLED=true|' "$REPO_DIR/.env"
        compose up -d
        echo 'Signups are closed.'
        exit 0
        ;;
    '')
        fail "usage: $0 <lan-ip> | lock"
        ;;
    *[!0-9.]*)
        fail "expected a LAN IPv4 address, got '$1'"
        ;;
esac
IP=$1

# ─── Docker and tools (sudo only when something is missing) ───
if ! command -v docker >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    $SUDO apt update
    $SUDO apt install -y curl openssl ca-certificates
    command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | $SUDO sh
fi
ensure_docker

# ─── Secrets (first install only) ───
cd "$REPO_DIR"
if [ ! -f .env ]; then
    jwt_secret=$(openssl rand -base64 30)
    iat=$(date +%s)
    exp=$((iat + 5 * 3600 * 24 * 365)) # 5 years, like upstream Supabase
    umask 077
    cat > .env <<EOF
DOMAIN=$IP
POSTGRES_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$jwt_secret
ANON_KEY=$(jwt "{\"role\":\"anon\",\"iss\":\"supabase\",\"iat\":$iat,\"exp\":$exp}")
SERVICE_ROLE_KEY=$(jwt "{\"role\":\"service_role\",\"iss\":\"supabase\",\"iat\":$iat,\"exp\":$exp}")
SECRET_KEY_BASE=$(openssl rand -base64 48)
REALTIME_DB_ENC_KEY=$(openssl rand -hex 8)
CRON_SECRET=$(openssl rand -hex 32)
AUTH_SIGNUPS_DISABLED=false
EOF
    umask 022
else
    echo '.env already exists, leaving it alone'
fi

# ─── Start everything ───
compose pull
compose up -d

# ─── Wait for a green health check ───
echo 'Waiting for the app to become healthy (first start takes a few minutes)...'
healthy=false
tries=0
while [ "$tries" -lt 120 ]; do
    if curl -s "http://$IP/api/health" | grep -q '"status":"healthy"'; then
        healthy=true
        break
    fi
    tries=$((tries + 1))
    sleep 5
done
[ "$healthy" = true ] || fail 'the app did not become healthy; check the logs with: docker compose -f docker-compose.selfhost.yml logs'

echo ''
echo "Done. Open http://$IP, create your account, then close signups"
echo "with: $0 lock"
