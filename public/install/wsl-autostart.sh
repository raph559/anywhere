#!/bin/sh
# Make the Anywhere agent start when you sign in to Windows (WSL only starts when Windows starts something in it).
# Installed by agent.sh; to add it to an agent that is already set up, run:
#   curl -fsSL https://HUB/install/wsl-autostart.sh | sh
# Option (environment): ANYWHERE_DIR (default ~/.anywhere-agent).
set -u
DIR=${ANYWHERE_DIR:-$HOME/.anywhere-agent}
say() { printf '\033[1;33m›\033[0m %s\n' "$*"; }
[ -n "${WSL_DISTRO_NAME:-}" ] || { say "Not running in WSL: nothing to do."; exit 0; }
command -v powershell.exe >/dev/null 2>&1 || { say "powershell.exe is not reachable from WSL (is Windows interop disabled?)."; exit 1; }
[ -f "$DIR/device_agent.py" ] && [ -f "$DIR/config.json" ] || { say "No agent found in $DIR. Add this device from Anywhere first."; exit 1; }
PY=$(command -v python3) || { say "python3 not found."; exit 1; }
cat > "$DIR/wsl-keepalive.sh" <<KEEP
#!/bin/sh
# Run by the "Anywhere agent (WSL)" Windows task at logon: start the agent (its lock keeps a single copy) and keep WSL awake.
nohup $PY $DIR/device_agent.py run --config $DIR/config.json >> "$DIR/agent.log" 2>&1 &
exec sleep infinity
KEEP
chmod 700 "$DIR/wsl-keepalive.sh"
TASK="Anywhere agent (WSL $WSL_DISTRO_NAME)"
if powershell.exe -NoProfile -NonInteractive -Command - >/dev/null 2>&1 <<PSH
\$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "wsl.exe -d $WSL_DISTRO_NAME -e $DIR/wsl-keepalive.sh"'
\$t = New-ScheduledTaskTrigger -AtLogOn -User \$env:USERNAME
\$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName '$TASK' -Action \$a -Trigger \$t -Settings \$s -Force | Out-Null
Start-ScheduledTask -TaskName '$TASK'
PSH
then say "Added the Windows task \"$TASK\": the agent now starts when you sign in to Windows."
else say "Could not add the Windows logon task (try again from a non-elevated terminal)."; exit 1; fi
