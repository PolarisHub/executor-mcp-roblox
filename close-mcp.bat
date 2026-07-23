@echo off
setlocal EnableExtensions

rem Close every executor-mcp-roblox launcher/main process and its child tree.
rem The bridge port check also catches instances started from another directory.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'SilentlyContinue'; $ids = [System.Collections.Generic.HashSet[int]]::new();" ^
  "$listeners = Get-NetTCPConnection -LocalPort 16384 -State Listen; foreach ($item in $listeners) { [void]$ids.Add([int]$item.OwningProcess) };" ^
  "$patterns = @('executor-mcp-roblox', '[\\/]dist[\\/]interface[\\/](launcher|main)\\.js', '[\\/]src[\\/]interface[\\/](launcher|main)\\.ts');" ^
  "$processes = Get-CimInstance Win32_Process | Where-Object { $commandLine = $_.CommandLine; $_.Name -match '(?i)^(node|nodejs)(\\.exe)?$' -and $commandLine -and ($patterns | Where-Object { $commandLine -match $_ }) };" ^
  "foreach ($process in $processes) { [void]$ids.Add([int]$process.ProcessId) };" ^
  "if ($ids.Count -eq 0) { Write-Host 'No executor-mcp-roblox process is running.' } else { foreach ($id in $ids) { if (Get-Process -Id $id) { Write-Host ('Stopping MCP process tree PID ' + $id); & taskkill.exe /PID $id /T /F | Out-Null } } };" ^
  "Start-Sleep -Milliseconds 300;" ^
  "$lockRoot = Join-Path $HOME '.executor-mcp'; Get-ChildItem $lockRoot -Filter 'launcher-*.lock' -File | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force };" ^
  "Write-Host 'executor-mcp-roblox has been closed.'"

if errorlevel 1 (
  echo Failed to close the MCP process tree.
  exit /b 1
)

exit /b 0
