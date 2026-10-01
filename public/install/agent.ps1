# Anywhere agent installer for Windows. Run the exact command shown in Anywhere, in PowerShell:
#   & { $h='https://HUB'; $c='CODE'; irm "$h/install/agent.ps1" | iex }
$ErrorActionPreference = 'Stop'
if (-not $h -or -not $c) { throw 'Run the command shown in Anywhere (it sets the hub address and the code).' }
$hub = $h.TrimEnd('/'); $dir = Join-Path $env:USERPROFILE '.anywhere-agent'
function Say($text) { Write-Host "> $text" -ForegroundColor Yellow }

$python = $null
foreach ($candidate in @('py', 'python')) {
  $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($cmd) {
    $pyArgs = if ($candidate -eq 'py') { @('-3', '-c') } else { @('-c') }
    $exe = & $cmd.Source @pyArgs 'import sys; print(sys.executable if sys.version_info >= (3, 10) else "")' 2>$null
    if ($exe) { $python = $exe.Trim(); break }
  }
}
if (-not $python) { throw 'Python 3.10 or newer is required: https://www.python.org/downloads/ (tick "Add to PATH").' }
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
if (-not (Test-Path $pythonw)) { $pythonw = $python }

$claude = (Get-Command claude.exe -ErrorAction SilentlyContinue).Source
if (-not $claude) { $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'; if (Test-Path $candidate) { $claude = $candidate } }
if (-not $claude) { throw 'Claude Code (claude.exe) was not found. Install it and sign in first: https://docs.claude.com/en/docs/claude-code' }

Say 'Installing the terminal dependency (pywinpty)'
& $python -m pip install --user --quiet --disable-pip-version-check pywinpty

Say "Installing the agent in $dir"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest -UseBasicParsing "$hub/install/device_agent.py" -OutFile (Join-Path $dir 'device_agent.py')

Say "Connecting to $hub"
try { $r = Invoke-RestMethod -Method Post -Uri "$hub/api/agents/enroll" -ContentType 'application/json' -Body (@{ code = $c } | ConvertTo-Json) }
catch { throw 'The code was refused. Create a new one in Anywhere (codes expire after 30 minutes and work once).' }
$config = [ordered]@{ deviceId = $r.deviceId; deviceSecret = $r.deviceSecret; hubUrl = $r.hubUrl; label = $r.label; claudePath = $claude
  roots = @(@{ name = 'Home'; path = $env:USERPROFILE }); defaultPath = $env:USERPROFILE; stateDir = 'state' }
if ($r.updatePublicKey) { $config.updatePublicKey = $r.updatePublicKey }
if ($r.hubUrl -like 'http://*') { $config.allowLocalHttp = $true }
$configPath = Join-Path $dir 'config.json'
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5))
& $python (Join-Path $dir 'device_agent.py') check --config $configPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "The agent check failed; run: $python $dir\device_agent.py check --config $configPath" }

Say 'Starting it now and at every sign-in'
$action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$dir\device_agent.py`" run --config `"$configPath`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Anywhere agent' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'Anywhere agent'
Write-Host 'Done. This device appears as online in Anywhere within a few seconds.' -ForegroundColor Green
