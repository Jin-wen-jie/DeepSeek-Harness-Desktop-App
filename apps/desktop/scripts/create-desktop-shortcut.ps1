# Creates a "Deepseek Harness" shortcut on the current user's Desktop pointing
# at the built Electron shell (electron.exe + apps\desktop\lib\main\index.js).
# Rebuild changed sources first: pnpm --filter @deepseek-ai/dsh-desktop run build
$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot   # apps\desktop
$desktop = [Environment]::GetFolderPath('Desktop')
$electron = Join-Path $appRoot 'node_modules\electron\dist\electron.exe'
$main = Join-Path $appRoot 'lib\main\index.js'

if (-not (Test-Path $electron)) { throw "electron.exe not found at $electron" }
if (-not (Test-Path $main)) { throw "built main entry not found at $main" }

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $desktop 'Deepseek Harness.lnk'))
$lnk.TargetPath = $electron
$lnk.Arguments = '"' + $main + '"'
$lnk.WorkingDirectory = $appRoot
$lnk.Description = 'Deepseek Harness desktop app'
$lnk.IconLocation = "$electron,0"
$lnk.Save()

Write-Host "Shortcut created: $(Join-Path $desktop 'Deepseek Harness.lnk')"
Write-Host "  Target:      $electron"
Write-Host "  Arguments:   $main"
Write-Host "  Working dir: $appRoot"
