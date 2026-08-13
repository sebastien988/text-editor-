@echo off
REM Serves the editor on http://localhost:8080 and opens your browser.
REM A local server is used rather than opening index.html directly so the
REM search Web Worker can load (file:// blocks workers).

setlocal
set PORT=8080
cd /d "%~dp0"

where py >nul 2>nul && (
  start "" http://localhost:%PORT%/index.html
  py -m http.server %PORT%
  goto :eof
)

where python >nul 2>nul && (
  start "" http://localhost:%PORT%/index.html
  python -m http.server %PORT%
  goto :eof
)

where node >nul 2>nul && (
  start "" http://localhost:%PORT%/index.html
  npx --yes http-server -p %PORT%
  goto :eof
)

echo Could not find Python or Node.js on your PATH.
echo You can still use the editor by opening index.html directly in your browser
echo (search will run on the main thread instead of a worker).
pause
