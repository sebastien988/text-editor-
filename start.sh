#!/usr/bin/env sh
# Serves the editor on http://localhost:8080 (macOS / Linux).
# A local server is used rather than opening index.html directly so the
# search Web Worker can load (file:// blocks workers).
set -e
PORT="${PORT:-8080}"
cd "$(dirname "$0")"

URL="http://localhost:$PORT/index.html"
(command -v open >/dev/null 2>&1 && open "$URL") \
  || (command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL") \
  || echo "Open $URL in your browser."

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  exec python -m http.server "$PORT"
elif command -v node >/dev/null 2>&1; then
  exec npx --yes http-server -p "$PORT"
else
  echo "Need Python or Node.js to serve. You can still open index.html directly."
  exit 1
fi
