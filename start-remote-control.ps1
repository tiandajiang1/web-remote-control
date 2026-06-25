$ErrorActionPreference = "Stop"

$ProjectDir = "C:\Users\t\Documents\web"
$Node = "C:\Program Files\nodejs\node.exe"

Set-Location $ProjectDir

$LocalEnvPath = Join-Path $ProjectDir ".env.local"
if (Test-Path $LocalEnvPath) {
  Get-Content $LocalEnvPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $name, $value = $line.Split("=", 2)
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process")
  }
}

$Token = if ($env:REMOTE_TOKEN) { $env:REMOTE_TOKEN } else { "change-me" }
$TunnelHost = $env:TUNNEL_HOST
$TunnelUser = if ($env:TUNNEL_USER) { $env:TUNNEL_USER } else { "ubuntu" }
$TunnelPassword = $env:TUNNEL_PASSWORD
$TunnelRemoteHost = if ($env:TUNNEL_REMOTE_HOST) { $env:TUNNEL_REMOTE_HOST } else { "0.0.0.0" }
$TunnelRemotePort = if ($env:TUNNEL_REMOTE_PORT) { $env:TUNNEL_REMOTE_PORT } else { "3000" }
$TunnelLocalHost = if ($env:TUNNEL_LOCAL_HOST) { $env:TUNNEL_LOCAL_HOST } else { "127.0.0.1" }
$TunnelLocalPort = if ($env:TUNNEL_LOCAL_PORT) { $env:TUNNEL_LOCAL_PORT } else { "3000" }
$PublicUrl = if ($env:PUBLIC_URL) { $env:PUBLIC_URL } else { "http://${TunnelHost}:${TunnelRemotePort}/" }

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

function Invoke-RemoteCommand {
  param([string]$Command)
  $previousCommand = $env:SSH_COMMAND_B64
  try {
    $env:TUNNEL_HOST = $TunnelHost
    $env:TUNNEL_USER = $TunnelUser
    $env:TUNNEL_PASSWORD = $TunnelPassword
    $env:SSH_COMMAND_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
    & $Node (Join-Path $ProjectDir "ssh-exec.js")
  } finally {
    if ($null -eq $previousCommand) {
      Remove-Item Env:SSH_COMMAND_B64 -ErrorAction SilentlyContinue
    } else {
      $env:SSH_COMMAND_B64 = $previousCommand
    }
  }
}

Stop-MatchingNode "*server.js*"
Stop-MatchingNode "*tunnel.js*"

$remotePrepCommand = @"
(command -v sudo >/dev/null 2>&1 && sudo fuser -k $TunnelRemotePort/tcp || fuser -k $TunnelRemotePort/tcp) || true
if [ -f /root/remote-control-proxy/proxy.py ]; then
  if ! pgrep -f '^python3 /root/remote-control-proxy/proxy.py' >/dev/null 2>&1; then
    nohup python3 /root/remote-control-proxy/proxy.py >/root/remote-control-proxy/proxy.log 2>&1 &
  fi
fi
"@

Invoke-RemoteCommand $remotePrepCommand

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

Start-Process $PublicUrl

Write-Host "Remote control started:"
Write-Host "  Local : http://127.0.0.1:3000/"
Write-Host "  Public: $PublicUrl"
Write-Host "  Token : $Token"
Start-Sleep -Seconds 3
