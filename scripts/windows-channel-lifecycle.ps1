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
  function RecordState($stage) {
    foreach ($id in $channels.stable, $channels.nightly) {
      $service = Get-CimInstance Win32_Service -Filter "Name='$($id.WINDOWS_SERVICE)'"
      $names = @("$($id.PRODUCT).exe", $id.WINDOWS_DAEMON, $id.WINDOWS_HELPER)
      $processes = @(Get-CimInstance Win32_Process | Where-Object Name -in $names | Select-Object Name,ProcessId)
      Write-Host (@{stage=$stage; installer=$exe; product=$id.PRODUCT; service=$service.State; pid=$service.ProcessId; processes=$processes} | ConvertTo-Json -Compress)
    }
  }
  RecordState before
  try {
    $process = Start-Process -FilePath (Resolve-Path -LiteralPath $exe).Path -ArgumentList $arguments -PassThru
    if (!$process.WaitForExit(180000) -or $process.ExitCode -ne 0) { throw "Failed running $exe ($($process.ExitCode))" }
  } finally { RecordState after }
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

function AuthorityPublicKey($identity, $data) {
  $helper = Join-Path $env:ProgramFiles "$($identity.PRODUCT)/resources/bin/$($identity.WINDOWS_HELPER)"
  $result = & $helper identity $data | ConvertFrom-Json
  if ($LASTEXITCODE -or [Convert]::FromBase64String($result.publicKey).Length -ne 32) {
    throw "Invalid installed public identity for $($identity.PRODUCT)"
  }
  return $result.publicKey
}

function AssertNightlyBuild([string]$setup) {
  $identity = $channels.nightly
  $root = Join-Path $env:ProgramFiles $identity.PRODUCT
  $version = (Get-Item -LiteralPath $setup).VersionInfo
  $stamp = node --input-type=module -e "import {extractFile} from '@electron/asar'; const read = f => JSON.parse(extractFile(process.argv[1], f)); console.log(JSON.stringify({...read('dist/channel.json'), version: read('package.json').version}))" "$root\resources\app.asar" | ConvertFrom-Json
  $number = [int64]0
  foreach ($part in $version.FileMajorPart,$version.FileMinorPart,$version.FileBuildPart,$version.FilePrivatePart) { $number = ($number -shl 16) + $part }
  if ($LASTEXITCODE -or $stamp.channel -ne 'nightly' -or $stamp.buildNumber -ne $number -or
      $number -lt 1 -or ($env:GITHUB_SHA -and $stamp.commit -ne $env:GITHUB_SHA) -or
      $stamp.version -ne $version.ProductVersion) {
    throw "Installed Nightly stamp differs from $setup"
  }
  Write-Host "Installed Nightly $($version.ProductVersion) build $number ($($stamp.commit))"
  return $number
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
  $shortcut = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "$product.lnk"
  if (!(Test-Path -LiteralPath $shortcut) -or (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath -ne "$root\$product.exe") {
    throw "Invalid $product Start menu shortcut"
  }
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
    if ($verifySignatures -and $role -ne 'asar') {
      $signature = Get-AuthenticodeSignature -LiteralPath $file
      if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)CN=Tyler Caldwell(?:,|$)') {
        throw "Invalid installed signature on $file"
      }
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

function Relaunch($view, $identity) {
  $window = Get-Process -Id $view.app[0]
  if (!$window.CloseMainWindow() -or !$window.WaitForExit(30000)) { throw "Could not relaunch $($view.product)" }
  StartChannel $identity
  Snapshot $identity 'after relaunch'
}

foreach ($identity in $channels.stable, $channels.nightly) {
  if ((InstalledEntry $identity) -or (Get-Service $identity.WINDOWS_SERVICE -ErrorAction SilentlyContinue)) {
    throw 'This test requires a fresh disposable machine'
  }
}
# Packaged clients refuse developer overrides inherited from a build shell.
$buildEnvironment = @(Get-ChildItem Env:APEX_*)
$verifySignatures = $env:APEX_DECK_WIN_SIGN -eq '1'
$uiScript = Join-Path $PSScriptRoot 'windows-channel-ui.ps1'
$run = [guid]::NewGuid().ToString('N').Substring(0,8)
$uiErrors = @{}
# Continue the installer checks when an interactive desktop is unavailable.
function CheckUI([string]$channelName, $action) {
  if ($uiErrors.ContainsKey($channelName)) { return }
  try { & $action } catch { $uiErrors[$channelName] = $_.Exception.Message; Write-Warning $_ }
}
try {
  foreach ($variable in $buildEnvironment) { Remove-Item -LiteralPath "Env:$($variable.Name)" }
  Setup $StableSetup
  StartChannel $channels.stable
  $stable = Snapshot $channels.stable 'before first Nightly install'
  $unusedFolder = Join-Path $env:TEMP "noncanonical-nightly-$run"
  $refused = Start-Process -FilePath (Resolve-Path $NightlySetup).Path -ArgumentList @('/S', "/D=$unusedFolder") -PassThru
  if (!$refused.WaitForExit(30000) -or $refused.ExitCode -ne 2 -or (Test-Path "$unusedFolder\resources\app.asar")) {
    throw 'Nightly Setup accepted an unexpected destination'
  }
  $first = if ($PreviousNightlySetup) { $PreviousNightlySetup } else { $NightlySetup }
  Setup $first
  $previous = AssertNightlyBuild $first
  StartChannel $channels.nightly
  $nightly = Snapshot $channels.nightly 'before Nightly upgrade'
  Survived $stable (Snapshot $channels.stable 'after first Nightly install')
  if ($stable.endpoint -eq $nightly.endpoint -or $stable.uninstall -eq $nightly.uninstall) { throw 'Channel identity collision' }
  if ((AuthorityPublicKey $channels.stable $stable.data) -ceq (AuthorityPublicKey $channels.nightly $nightly.data)) {
    throw 'The two installed authorities expose the same signing key'
  }
  Write-Host 'The installed Stable and Nightly authorities have different Ed25519 public keys for this Windows user.'
  CheckUI stable { & $uiScript -Channel stable -AppId $stable.app[0] -CreateSample -Post "stable-$run" }
  CheckUI nightly { & $uiScript -Channel nightly -AppId $nightly.app[0] -CreateSample -Post "nightly-$run" -Exclude "stable-$run" }
  $stable = Relaunch $stable $channels.stable
  $nightly = Relaunch $nightly $channels.nightly
  CheckUI stable { & $uiScript -Channel stable -AppId $stable.app[0] -Expect "stable-$run" -Exclude "nightly-$run" }
  CheckUI nightly { & $uiScript -Channel nightly -AppId $nightly.app[0] -Expect "nightly-$run" -Exclude "stable-$run" }
  Setup $NightlySetup
  $current = AssertNightlyBuild $NightlySetup
  if ($PreviousNightlySetup -and ($current -le $previous -or
      (Get-Item $first).VersionInfo.ProductVersion -ne (Get-Item $NightlySetup).VersionInfo.ProductVersion)) {
    throw 'Expected a higher Nightly build at the same semver'
  }
  if ($verifySignatures -and $PreviousNightlySetup) {
    $env:APEX_CHANNEL = 'nightly'
    $env:APEX_BUILD_NUMBER = [string]$current
    try {
      $product = $channels.nightly.PRODUCT
      node "$PSScriptRoot/windows-update-smoke.mjs" $NightlySetup "$env:ProgramFiles/$product/$product.exe" $PreviousNightlySetup
      if ($LASTEXITCODE) { throw 'Signed Nightly pair failed verification' }
    } finally { Remove-Item Env:APEX_CHANNEL,Env:APEX_BUILD_NUMBER }
  }
  Survived $stable (Snapshot $channels.stable 'after Nightly upgrade')
  CheckUI stable { & $uiScript -Channel stable -AppId $stable.app[0] -Post "stable-after-upgrade-$run" }
  StartChannel $channels.nightly
  $null = Snapshot $channels.nightly 'before Nightly uninstall'
  $nightlyRoot = Join-Path $env:ProgramFiles $channels.nightly.PRODUCT
  # Run the actual uninstaller outside the tree it removes, as Setup does when upgrading.
  $uninstaller = Join-Path $env:TEMP "uninstall-nightly-$run.exe"
  Copy-Item -LiteralPath "$nightlyRoot\Uninstall $($channels.nightly.PRODUCT).exe" -Destination $uninstaller
  Setup $uninstaller @('/S', '/allusers', "_?=$nightlyRoot")
  Survived $stable (Snapshot $channels.stable 'after Nightly uninstall')
  TestAuthority stable
  CheckUI stable { & $uiScript -Channel stable -AppId $stable.app[0] -Post "stable-after-uninstall-$run" -Expect "stable-$run" }
  if ((InstalledEntry $channels.nightly) -or (Get-Service $channels.nightly.WINDOWS_SERVICE -ErrorAction SilentlyContinue) -or
      (Get-ScheduledTask -TaskName $channels.nightly.WINDOWS_TASK -ErrorAction SilentlyContinue)) { throw 'Nightly registration survived uninstall' }
  Setup $NightlySetup
  StartChannel $channels.nightly
  $nightly = Snapshot $channels.nightly 'before Stable upgrade'
  $null = Snapshot $channels.stable 'before Stable upgrade'
  Setup $StableSetup
  Survived $nightly (Snapshot $channels.nightly 'after candidate Stable installer')
  CheckUI nightly { & $uiScript -Channel nightly -AppId $nightly.app[0] -Post "nightly-after-stable-$run" -Expect "nightly-$run" }
  StartChannel $channels.stable
  Setup $ExistingStableSetup
  Survived $nightly (Snapshot $channels.nightly 'after shipped Stable installer')
  TestAuthority nightly
  CheckUI nightly { & $uiScript -Channel nightly -AppId $nightly.app[0] -Post "nightly-after-historical-$run" }
  StartChannel $channels.stable
  $null = Snapshot $channels.stable 'before Stable upgrade from shipped build'
  Setup $StableSetup
  Survived $nightly (Snapshot $channels.nightly 'after Stable upgrade from shipped build')
  StartChannel $channels.stable
  $stable = Snapshot $channels.stable 'after Stable upgrade from shipped build'
  TestAuthority stable
  $stable = Relaunch $stable $channels.stable
  $nightly = Relaunch $nightly $channels.nightly
  $stableMessages = @("stable-$run","stable-after-upgrade-$run","stable-after-uninstall-$run")
  $nightlyMessages = @("nightly-$run","nightly-after-stable-$run","nightly-after-historical-$run")
  CheckUI stable { & $uiScript -Channel stable -AppId $stable.app[0] -Expect $stableMessages -Exclude $nightlyMessages }
  CheckUI nightly { & $uiScript -Channel nightly -AppId $nightly.app[0] -Expect $nightlyMessages -Exclude $stableMessages }
  if ($uiErrors.Count) { throw ($uiErrors.Values -join [Environment]::NewLine) }
} finally {
  foreach ($variable in $buildEnvironment) { Set-Item -LiteralPath "Env:$($variable.Name)" -Value $variable.Value }
}
