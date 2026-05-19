$ErrorActionPreference = "Stop"

$ProjectDir = "C:\Users\t\Documents\web"
$Node = "C:\Program Files\nodejs\node.exe"

$Token = if ($env:REMOTE_TOKEN) { $env:REMOTE_TOKEN } else { "change-me" }
$TunnelHost = $env:TUNNEL_HOST
$TunnelUser = if ($env:TUNNEL_USER) { $env:TUNNEL_USER } else { "ubuntu" }
$TunnelPassword = $env:TUNNEL_PASSWORD
$TunnelRemoteHost = if ($env:TUNNEL_REMOTE_HOST) { $env:TUNNEL_REMOTE_HOST } else { "0.0.0.0" }
$TunnelRemotePort = if ($env:TUNNEL_REMOTE_PORT) { $env:TUNNEL_REMOTE_PORT } else { "3000" }
$TunnelLocalHost = if ($env:TUNNEL_LOCAL_HOST) { $env:TUNNEL_LOCAL_HOST } else { "127.0.0.1" }
$TunnelLocalPort = if ($env:TUNNEL_LOCAL_PORT) { $env:TUNNEL_LOCAL_PORT } else { "3000" }

if (-not $TunnelHost -or -not $TunnelPassword) {
  Write-Host "Please set TUNNEL_HOST and TUNNEL_PASSWORD before starting the public tunnel."
  Write-Host "Example:"
  Write-Host '  $env:TUNNEL_HOST="your.server.ip"'
  Write-Host '  $env:TUNNEL_PASSWORD="your-password"'
  Write-Host '  $env:REMOTE_TOKEN="your-token"'
  exit 1
}

function Stop-MatchingNode {
  param([string]$Pattern)
  try {
    Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
      Where-Object { $_.CommandLine -like $Pattern } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {
    Write-Host "Skip process cleanup: $($_.Exception.Message)"
  }
}

function Start-HiddenPowerShell {
  param([string]$Command)
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", $Command
  ) -WindowStyle Hidden
}

Set-Location $ProjectDir

Stop-MatchingNode "*server.js*"
Stop-MatchingNode "*tunnel.js*"

$serverCommand = @"
`$env:REMOTE_TOKEN='$Token';
Set-Location '$ProjectDir';
& '$Node' server.js
"@

$tunnelCommand = @"
`$env:TUNNEL_HOST='$TunnelHost';
`$env:TUNNEL_USER='$TunnelUser';
`$env:TUNNEL_PASSWORD='$TunnelPassword';
`$env:TUNNEL_REMOTE_HOST='$TunnelRemoteHost';
`$env:TUNNEL_REMOTE_PORT='$TunnelRemotePort';
`$env:TUNNEL_LOCAL_HOST='$TunnelLocalHost';
`$env:TUNNEL_LOCAL_PORT='$TunnelLocalPort';
Set-Location '$ProjectDir';
& '$Node' tunnel.js
"@

Start-HiddenPowerShell $serverCommand
Start-Sleep -Seconds 1
Start-HiddenPowerShell $tunnelCommand
Start-Sleep -Seconds 2

Start-Process "http://${TunnelHost}:${TunnelRemotePort}/"

Write-Host "Remote control started:"
Write-Host "  Local : http://127.0.0.1:3000/"
Write-Host "  Public: http://${TunnelHost}:${TunnelRemotePort}/"
Write-Host "  Token : $Token"
Start-Sleep -Seconds 3
