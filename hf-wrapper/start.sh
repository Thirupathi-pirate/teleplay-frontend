#!/bin/bash
# ============================================================================
# HF Wrapper — Generic Hugging Face Space entrypoint
#
# Order of operations (strict):
#   1. If SYNC_FILE is set → restore file from HF Dataset before anything else
#   2. Run cloudflare-proxy-setup.py (sets up Cloudflare Workers proxy)
#   3. Source the proxy env file (CLOUDFLARE_PROXY_URL, CLOUDFLARE_PROXY_SECRET)
#   4. Set NODE_OPTIONS to require cloudflare-proxy.js if proxy URL is set
#   5. Run cloudflare-keepalive-setup.py (creates keep-awake Worker with cron)
#   6. Start health-server.js in background (configurable HEALTH_SERVER_PORT, default 7860)
#   7. If SYNC_FILE is set → start sync.py in background (periodic HF Dataset backup)
#   8. Start the app using APP_START_CMD environment variable (foreground)
# ============================================================================

set -euo pipefail

# Sanitize SYNC_INTERVAL: strip non-digits, clamp minimum to 60s
_SYNC_INTERVAL=$(printf '%s' "${SYNC_INTERVAL:-300}" | tr -dc '0-9')
{ [ -z "${_SYNC_INTERVAL}" ] || [ "${_SYNC_INTERVAL}" -lt 60 ]; } && _SYNC_INTERVAL=300
export SYNC_INTERVAL="${_SYNC_INTERVAL}"
unset _SYNC_INTERVAL

# Derive SPACE_HOST from SPACE_URL if not already set (keepalive script needs it)
if [ -z "${SPACE_HOST:-}" ] && [ -n "${SPACE_URL:-}" ]; then
    SPACE_HOST=$(echo "${SPACE_URL}" | sed 's|https\?://||' | sed 's|/.*||')
    export SPACE_HOST
fi

# ── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo "  ╔════════════════════════════════════╗"
echo "  ║          HF Wrapper                ║"
echo "  ║  Generic Hugging Face Space Setup  ║"
echo "  ╚════════════════════════════════════╝"
echo ""

# ── Step 1: Restore backed-up file from HF Dataset (if configured) ─────────
if [ -n "${SYNC_FILE:-}" ]; then
    echo "Restoring ${SYNC_FILE} from HF Dataset..."
    python3 /opt/hf-wrapper/sync.py restore 2>&1 || echo "Warning: Restore failed — continuing without restored file"
else
    echo "SYNC_FILE not set — skipping dataset restore"
fi

# ── Step 2: Cloudflare proxy setup ──────────────────────────────────────────
if [ -n "${CLOUDFLARE_WORKERS_TOKEN:-}" ]; then
    echo "Setting up Cloudflare proxy worker..."
    python3 /opt/hf-wrapper/cloudflare-proxy-setup.py 2>&1 \
        || echo "Warning: Cloudflare proxy setup failed — continuing without proxy"
else
    echo "CLOUDFLARE_WORKERS_TOKEN not set — skipping Cloudflare proxy setup"
fi

# ── Step 3: Source the proxy env file for CLOUDFLARE_PROXY_URL/CLOUDFLARE_PROXY_SECRET ──
_CF_ENV="/tmp/huggingpost-cloudflare-proxy.env"
if [ -f "${_CF_ENV}" ]; then
    # shellcheck source=/dev/null
    . "${_CF_ENV}"
fi

# ── Step 4: Enable Cloudflare proxy via NODE_OPTIONS if deployed ────────────
if [ -n "${CLOUDFLARE_PROXY_URL:-}" ] && [ -f /opt/hf-wrapper/cloudflare-proxy.js ]; then
    export NODE_OPTIONS="${NODE_OPTIONS:-} --require /opt/hf-wrapper/cloudflare-proxy.js"
    echo "Cloudflare proxy active via NODE_OPTIONS"
fi

# ── Step 5: Cloudflare keepalive setup ──────────────────────────────────────
if [ -n "${CLOUDFLARE_WORKERS_TOKEN:-}" ]; then
    echo "Setting up Cloudflare keepalive worker..."
    python3 /opt/hf-wrapper/cloudflare-keepalive-setup.py 2>&1 \
        || echo "Warning: Cloudflare keepalive setup failed — continuing without keep-awake"
fi

# ── Step 6: Start health server (background) ────────────────────────────────
# HEALTH_SERVER_PORT configures which port the health server listens on.
# Default 7860 (HF Spaces exposed port). If your app also needs 7860, set
# HEALTH_SERVER_PORT to a different value (e.g. 7861) so both can coexist.
HEALTH_SERVER_PORT="${HEALTH_SERVER_PORT:-7860}"
sed -i "s/const PORT = [0-9]\+/const PORT = ${HEALTH_SERVER_PORT}/" \
    /opt/hf-wrapper/healthsrv/health-server.js
echo "Starting health server on port ${HEALTH_SERVER_PORT}..."
node /opt/hf-wrapper/healthsrv/health-server.js &
HEALTH_PID=$!
echo "Health server started (PID: ${HEALTH_PID})"

# ── Step 7: Start HF Dataset sync loop (background, if configured) ─────────
SYNC_PID=""
if [ -n "${SYNC_FILE:-}" ]; then
    echo "Starting file sync loop (interval: ${SYNC_INTERVAL:-300}s)..."
    (
        while true; do
            python3 /opt/hf-wrapper/sync.py sync 2>&1 || true
            sleep "${SYNC_INTERVAL:-300}"
        done
    ) &
    SYNC_PID=$!
else
    echo "SYNC_FILE not set — sync loop disabled"
fi

# ── Step 8: Start the user's app ──────────────────────────────────────────
if [ -z "${APP_START_CMD:-}" ]; then
    echo ""
    echo "  ┌─────────────────────────────────────────────────────┐"
    echo "  │  ERROR: APP_START_CMD is not set.                   │"
    echo "  │  Set this environment variable to the command       │"
    echo "  │  that starts your application.                      │"
    echo "  │                                                     │"
    echo "  │  Example:                                           │"
    echo "  │    ENV APP_START_CMD=\"uvicorn app.main:app \\       │"
    echo "  │      --host 0.0.0.0 --port 7860\"                   │"
    echo "  └─────────────────────────────────────────────────────┘"
    echo ""
    exit 1
fi

# ── Graceful shutdown ──────────────────────────────────────────────────────
# Traps SIGTERM/SIGINT so cleanup (health server, sync loop, final backup)
# actually runs. The app is started in the background (no exec) so the shell
# stays as PID 1 and receives signals from Docker.
cleanup() {
    local exit_code=${1:-$?}
    echo ""
    echo "Shutting down..."
    [ -n "${HEALTH_PID:-}" ] && kill "${HEALTH_PID}" 2>/dev/null || true
    [ -n "${SYNC_PID:-}" ] && kill "${SYNC_PID}" 2>/dev/null || true
    wait 2>/dev/null || true
    if [ -n "${SYNC_FILE:-}" ]; then
        echo "Running final sync before shutdown..."
        python3 /opt/hf-wrapper/sync.py sync 2>&1 || true
    fi
    exit $exit_code
}

# App runs in background so signals reach this shell for trap handling.
# Without exec, the shell remains PID 1 and trap catches SIGTERM/SIGINT.
trap 'cleanup 0' SIGTERM SIGINT

echo "Starting application: ${APP_START_CMD}"
${APP_START_CMD} &
APP_PID=$!

# Wait for app to finish (disable set -e so crash doesn't skip cleanup)
set +e
wait $APP_PID
APP_EXIT=$?
set -e

# Normal exit: cleanup and preserve exit code
cleanup $APP_EXIT
