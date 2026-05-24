#!/usr/bin/env bash
# Launch a Chrome instance with CDP enabled on 127.0.0.1:9222 for chrome-devtools-mcp.
# Idempotent: if something already listens on 9222, reuse it.
# Uses an independent profile so it does not conflict with the user's daily Chrome.

set -euo pipefail

PORT=9222
PROFILE_DIR="${CHROME_DEBUG_PROFILE:-$HOME/.chrome-debug}"
LOG_FILE="${CHROME_DEBUG_LOG:-$HOME/.chrome-debug/chrome-debug.log}"
# Auto-enable headless when no X server is available (e.g. SSH session).
HEADLESS="${CHROME_HEADLESS:-}"
if [ -z "$HEADLESS" ]; then
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    HEADLESS=1
  else
    HEADLESS=0
  fi
fi

is_listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$PORT" 2>/dev/null | tail -n +2 | grep -q ":$PORT"
  else
    netstat -ltn 2>/dev/null | grep -q ":$PORT "
  fi
}

wait_cdp_ready() {
  local wait=0
  while ! curl -sf --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; do
    sleep 1
    wait=$((wait + 1))
    if [ $wait -ge 30 ]; then
      echo "[!] Chrome did not open CDP within 30s. Abort." >&2
      return 1
    fi
  done
}

if is_listening; then
  echo "[=] Port $PORT already listening. Reusing existing Chrome instance."
  curl -s "http://127.0.0.1:$PORT/json/version" | head -c 200 || true
  echo
  exit 0
fi

CHROME_BIN=""

if [[ "$(uname)" == "Darwin" ]]; then
  for app in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
             "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if [ -x "$app" ]; then
      CHROME_BIN="$app"
      break
    fi
  done
fi

if [ -z "$CHROME_BIN" ]; then
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      CHROME_BIN=$(command -v "$candidate")
      break
    fi
  done
fi

if [ -z "$CHROME_BIN" ]; then
  cat >&2 <<EOF
[!] Chrome/Chromium binary not found.
    macOS: install Google Chrome to /Applications
    Linux: sudo apt install -y chromium-browser
EOF
  exit 1
fi

mkdir -p "$PROFILE_DIR" "$(dirname "$LOG_FILE")"

HEADLESS_ARGS=()
if [ "$HEADLESS" = "1" ]; then
  HEADLESS_ARGS=(--headless=new --disable-gpu --no-sandbox)
  echo "[+] Headless mode enabled (no DISPLAY detected)."
fi

PROXY_ARGS=()
if [ -n "${CHROME_PROXY:-}" ]; then
  PROXY_ARGS=(--proxy-server="$CHROME_PROXY")
  echo "[+] Proxy enabled: $CHROME_PROXY"
fi

echo "[+] Launching $CHROME_BIN with remote debugging on 127.0.0.1:$PORT"
echo "    Profile dir: $PROFILE_DIR"
echo "    Log file:    $LOG_FILE"

nohup "$CHROME_BIN" \
  --remote-debugging-port=$PORT \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "${HEADLESS_ARGS[@]}" \
  "${PROXY_ARGS[@]}" \
  >"$LOG_FILE" 2>&1 &

disown || true

if wait_cdp_ready; then
  echo "[+] Chrome CDP ready at http://127.0.0.1:$PORT"
  curl -s "http://127.0.0.1:$PORT/json/version" | head -c 200 || true
  echo
else
  exit 1
fi
