@echo off
rem Launch wrapper for the Deepseek Harness desktop app (built Electron shell).
rem The app entry is apps\desktop\lib; rebuild changed sources with:
rem   pnpm --filter @deepseek-ai/dsh-desktop run build
rem The desktop shortcut is created by apps\desktop\scripts\create-desktop-shortcut.ps1
cd /d "%~dp0apps\desktop"

if not exist "lib\main\index.js" (
  echo Desktop app is not built yet. Run: pnpm --filter @deepseek-ai/dsh-desktop run build 1>&2
  exit /b 1
)

"%~dp0apps\desktop\node_modules\electron\dist\electron.exe" "%~dp0apps\desktop\lib\main\index.js"
