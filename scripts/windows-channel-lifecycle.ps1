# Run elevated on a fresh disposable Windows VM. The installers manage real services and tasks.
param(
  [Parameter(Mandatory)][string]$StableSetup,
  [Parameter(Mandatory)][string]$NightlySetup,
  [string]$PreviousNightlySetup,
  [string]$ExistingStableSetup = $StableSetup
)
$ErrorActionPreference = 'Stop'
$channels = Get-Content "$PSScriptRoot/../desktop/channels.json" -Raw | ConvertFrom-Json
$registry = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

function InstalledEntry($identity) {
  $uninstaller = Join-Path "$env:ProgramFiles\$($identity.PRODUCT)" "Uninstall $($identity.PRODUCT).exe"
  Get-ItemProperty $registry -ErrorAction SilentlyContinue | Where-Object { $_.UninstallString -like "*`"$uninstaller`"*" }
}

function Setup([string]$exe, [string[]]$arguments = @('/S')) {
  $process = Start-Process -FilePath (Resolve-Path -LiteralPath $exe).Path -ArgumentList $arguments -PassThru
  if (!$process.WaitForExit(180000) -or $process.ExitCode -ne 0) { throw "Failed running $exe ($($process.ExitCode))" }
}

function StartChannel($identity) {
  $root = Join-Path $env:ProgramFiles $identity.PRODUCT
  if (!(Get-Process -Name $identity.PRODUCT -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath "$root\$($identity.PRODUCT).exe"
  }
  $deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $identity.WINDOWS_TASK -ErrorAction SilentlyContinue
    $ready = $task.State -eq 'Running' -and (Test-Path "$env:APPDATA\$($identity.PRODUCT)\daemon.json")
  } until ($ready -or (Get-Date) -gt $deadline)
  if (!$ready) { throw "Daemon task failed to start for $($identity.PRODUCT)" }
}

function TestAuthority([string]$name) {
  $identity = $channels.$name
  $env:APEX_CHANNEL = $name
  try {
    node "$PSScriptRoot/windows-authority-smoke.mjs" "$env:ProgramFiles\$($identity.PRODUCT)\resources\bin\$($identity.WINDOWS_DAEMON)"
    if ($LASTEXITCODE) { throw "Installed $name authority smoke failed" }
  } finally { Remove-Item Env:APEX_CHANNEL }
}

function Snapshot($identity, $stage) {
  $product = $identity.PRODUCT
  $root = Join-Path $env:ProgramFiles $product
  $daemon = "$root\resources\bin\$($identity.WINDOWS_DAEMON)"
  $authority = Join-Path $env:ProgramData $identity.WINDOWS_ROOT
  $profile = Join-Path $env:APPDATA $identity.PROFILE_ID
  $broker = Get-CimInstance Win32_Service -Filter "Name='$($identity.WINDOWS_SERVICE)'"
  $task = Get-ScheduledTask -TaskName $identity.WINDOWS_TASK
  $entry = @(InstalledEntry $identity)
  $data = & $daemon data-dir
  $endpoint = & $daemon endpoint
  $pipes = [IO.Directory]::GetFiles('\\.\pipe\')
  if ($entry.Count -ne 1 -or $broker.State -ne 'Running' -or $task.State -ne 'Running' -or
      $task.Actions.Arguments -notlike "*$($identity.WINDOWS_LAUNCHER)*" -or
      $data -ne (Join-Path $env:APPDATA $product) -or !(Test-Path -LiteralPath $profile) -or
      $pipes -notcontains $identity.WINDOWS_PIPE -or $pipes -notcontains $endpoint) {
    throw "Incomplete $product installation at $stage"
  }
  $pins = Get-Content "$authority\config.json" -Raw | ConvertFrom-Json
  $files = @{ui="$root\$product.exe"; asar="$root\resources\app.asar"; helper="$root\resources\bin\$($identity.WINDOWS_HELPER)"; daemon=$daemon}
  foreach ($role in $files.Keys) {
    $file = $files[$role]
    if ($pins.$role.path -ne "\\?\$file" -or $pins.$role.sha256 -ne (Get-FileHash -LiteralPath $file).Hash) {
      throw "$product has an incorrect $role pin"
    }
  }
  $info = Get-Content "$data\daemon.json" -Raw | ConvertFrom-Json
  $running = Get-Process -Id $info.pid
  if ("$($running.ProcessName).exe" -ne $identity.WINDOWS_DAEMON) { throw "Unexpected daemon at $endpoint" }
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='$product.exe'")
  $app = @($processes | Where-Object { $processes.ProcessId -notcontains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId)
  if ($app.Count -ne 1) { throw "Expected one main process for $product at $stage, found $app" }
  $result = [pscustomobject]@{ product=$product; stage=$stage; app=$app; daemon=$info.pid; broker=$broker.ProcessId;
    state=$broker.State; task=$task.TaskName; launcher=$task.Actions.Arguments; endpoint=$endpoint;
    pipe=$identity.WINDOWS_PIPE; profile=$profile; data=$data; authority=$authority; uninstall=$entry[0].PSChildName }
  Write-Host ($result | ConvertTo-Json -Compress)
  return $result
}

function Survived($before, $after) {
  if ($before.daemon -ne $after.daemon -or $before.broker -ne $after.broker -or
      $before.app[0] -ne $after.app[0] -or $before.uninstall -ne $after.uninstall) {
    throw "$($before.product) restarted or its registration changed during $($after.stage)"
  }
}

foreach ($identity in $channels.stable, $channels.nightly) {
  if ((InstalledEntry $identity) -or (Get-Service $identity.WINDOWS_SERVICE -ErrorAction SilentlyContinue)) {
    throw 'This test requires a fresh disposable machine'
  }
}
# Packaged clients refuse developer overrides inherited from a build shell.
$buildEnvironment = @(Get-ChildItem Env:APEX_*)
try {
  foreach ($variable in $buildEnvironment) { Remove-Item -LiteralPath "Env:$($variable.Name)" }
  Setup $StableSetup
  StartChannel $channels.stable
  $stable = Snapshot $channels.stable 'before first Nightly install'
  if ($PreviousNightlySetup) { Setup $PreviousNightlySetup } else { Setup $NightlySetup }
  StartChannel $channels.nightly
  $nightly = Snapshot $channels.nightly 'before Nightly upgrade'
  Survived $stable (Snapshot $channels.stable 'after first Nightly install')
  if ($stable.endpoint -eq $nightly.endpoint -or $stable.uninstall -eq $nightly.uninstall) { throw 'Channel identity collision' }
  Setup $NightlySetup
  Survived $stable (Snapshot $channels.stable 'after Nightly upgrade')
  StartChannel $channels.nightly
  $null = Snapshot $channels.nightly 'before Nightly uninstall'
  $nightlyRoot = Join-Path $env:ProgramFiles $channels.nightly.PRODUCT
  Setup "$nightlyRoot\Uninstall $($channels.nightly.PRODUCT).exe" @('/S', "/allusers", "_?=$nightlyRoot")
  Survived $stable (Snapshot $channels.stable 'after Nightly uninstall')
  TestAuthority stable
  if ((InstalledEntry $channels.nightly) -or (Get-Service $channels.nightly.WINDOWS_SERVICE -ErrorAction SilentlyContinue) -or
      (Get-ScheduledTask -TaskName $channels.nightly.WINDOWS_TASK -ErrorAction SilentlyContinue)) { throw 'Nightly registration survived uninstall' }
  Setup $NightlySetup
  StartChannel $channels.nightly
  $nightly = Snapshot $channels.nightly 'before Stable upgrade'
  $null = Snapshot $channels.stable 'before Stable upgrade'
  Setup $ExistingStableSetup
  Survived $nightly (Snapshot $channels.nightly 'after Stable upgrade')
  TestAuthority nightly
} finally {
  foreach ($variable in $buildEnvironment) { Set-Item -LiteralPath "Env:$($variable.Name)" -Value $variable.Value }
}
