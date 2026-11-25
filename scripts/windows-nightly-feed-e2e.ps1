# Run elevated on a fresh disposable Windows runner only. Installs the PUBLISHED
# Windows Nightly named by the live feed, opens it, and reads what its own updater
# reports in Settings > About & updates.
#
# Control: the app first starts with outbound network blocked for its own exe, so
# its first check must fail. Unblocked, "Check now" must then report Up to date.
# That shows the Up to date answer came from a real fetch of the feed, not a no-op.
param([Parameter(Mandatory)][string]$Work)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$identity = (Get-Content "$PSScriptRoot/../desktop/channels.json" -Raw | ConvertFrom-Json).nightly
$product = $identity.PRODUCT
$root = Join-Path $env:ProgramFiles $product
$exe = Join-Path $root "$product.exe"
$rule = 'ApexNightlyFeedE2E-block'
$null = New-Item -ItemType Directory -Force $Work
# The feed checker reads the channel from APEX_CHANNEL. Only it gets the variable:
# the trusted app refuses to start with any APEX_* override.
function FeedCheck([string[]]$CheckArgs) {
  $env:APEX_CHANNEL = 'nightly'
  try { & node "$PSScriptRoot/windows-nightly-feed-check.mjs" @CheckArgs } finally { Remove-Item Env:APEX_CHANNEL -ErrorAction SilentlyContinue }
}

function Step($text) { Write-Host "::group::$text" }
function EndStep { Write-Host '::endgroup::' }
function Evidence($name, $value) { Write-Host "EVIDENCE $name $($value | ConvertTo-Json -Compress -Depth 6)" }

# 1. The published feed, read with the updater's own parser, and the installer it names.
Step 'Read the published feed and download the installer it names'
$out = FeedCheck @((Join-Path $Work 'download'))
if ($LASTEXITCODE) { throw 'Feed check failed' }
$out | ForEach-Object { Write-Host $_ }
$feed = ($out | Select-Object -Last 1) | ConvertFrom-Json
EndStep

Step 'Inspect the downloaded Setup.exe'
$sig = Get-AuthenticodeSignature -LiteralPath $feed.installer
$info = (Get-Item -LiteralPath $feed.installer).VersionInfo
$words = @(48,32,16,0 | ForEach-Object { [math]::Floor($feed.buildNumber / [math]::Pow(2,$_)) % 65536 }) -join '.'
$pe = @{ status="$($sig.Status)"; signer=$sig.SignerCertificate.Subject; issuer=$sig.SignerCertificate.Issuer;
  product=$info.ProductName; productVersion=$info.ProductVersion;
  fileVersion="$($info.FileMajorPart).$($info.FileMinorPart).$($info.FileBuildPart).$($info.FilePrivatePart)"; expectedFileVersion=$words }
Evidence 'setup' $pe
if ($pe.status -ne 'Valid' -or $pe.signer -notmatch '(?:^|,\s*)CN=Tyler Caldwell(?:,|$)' -or $pe.product -ne $product -or
    $pe.fileVersion -ne $words -or $pe.productVersion -ne $feed.version) { throw 'Published Setup.exe identity is wrong' }
EndStep

# 2. Install it the way a person would, silently, on a machine with no Apex Deck.
Step 'Install the published Nightly'
if (Test-Path -LiteralPath $root) { throw "$root already exists; this runner is not fresh" }
# Block before installing, in case setup opens the app itself: its first check must not reach GitHub.
Set-NetFirewallProfile -All -Enabled True -DefaultOutboundAction Allow
$null = New-NetFirewallRule -DisplayName $rule -Direction Outbound -Program $exe -Action Block
$p = Start-Process -FilePath $feed.installer -ArgumentList '/S' -PassThru
if (!$p.WaitForExit(300000) -or $p.ExitCode -ne 0) { throw "Installer failed ($($p.ExitCode))" }
$appSig = Get-AuthenticodeSignature -LiteralPath $exe
Evidence 'installed' @{ exe=$exe; signature="$($appSig.Status)"; signer=$appSig.SignerCertificate.Subject;
  service=(Get-Service $identity.WINDOWS_SERVICE).Status.ToString() }
EndStep

Step 'The installed app''s own signer accepts the feed''s installer as this build'
$out = FeedCheck @((Join-Path $Work 'download-2'), $exe)
if ($LASTEXITCODE) { throw 'Installed-signer verification failed' }
$out | ForEach-Object { Write-Host $_ }
EndStep

# 3. UI Automation helpers for the installed window.
if (!('FeedUiWindow' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FeedUiWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out Rect r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr w, IntPtr dc, uint f);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
}
$shell = New-Object -ComObject WScript.Shell
$script:app = $null

function MainWindowProcess {
  $deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep -Milliseconds 500
    $all = @(Get-CimInstance Win32_Process -Filter "Name='$product.exe'")
    $main = @($all | Where-Object { $all.ProcessId -notcontains $_.ParentProcessId })
    $ok = $main.Count -eq 1 -and (Get-Process -Id $main[0].ProcessId).MainWindowHandle -ne [IntPtr]::Zero
  } until ($ok -or (Get-Date) -gt $deadline)
  if (!$ok) { throw "No $product window" }
  Get-Process -Id $main[0].ProcessId
}

function Window {
  $script:app.Refresh()
  $h = $script:app.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { return }
  if ([FeedUiWindow]::GetForegroundWindow() -ne $h) { $null = $shell.AppActivate($script:app.Id); $null = [FeedUiWindow]::SetForegroundWindow($h) }
  [Windows.Automation.AutomationElement]::FromHandle($h)
}

function Find([string]$pattern, $type) {
  $w = Window
  if (!$w) { return }
  $cond = if ($type) { [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $type) } else { [Windows.Automation.Condition]::TrueCondition }
  foreach ($e in $w.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)) {
    try { if ($e.Current.Name -match $pattern) { return $e } } catch [Windows.Automation.ElementNotAvailableException] { }
  }
}

function Dump([string]$why) {
  Write-Host "UI dump ($why):"
  $w = Window
  if (!$w) { Write-Host 'no window'; return }
  $n = 0
  foreach ($e in $w.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
    try {
      $name = ($e.Current.Name -replace '\s+',' ').Trim()
      if ($name) { Write-Host ("  {0} enabled={1} '{2}'" -f $e.Current.ControlType.ProgrammaticName, $e.Current.IsEnabled, $name.Substring(0,[Math]::Min(140,$name.Length))); $n++ }
    } catch { }
    if ($n -ge 250) { break }
  }
  try {
    Add-Type -AssemblyName System.Drawing
    $r = [FeedUiWindow+Rect]::new(); $null = [FeedUiWindow]::GetWindowRect($script:app.MainWindowHandle, [ref]$r)
    $bmp = [Drawing.Bitmap]::new($r.Right - $r.Left, $r.Bottom - $r.Top); $g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
    $null = [FeedUiWindow]::PrintWindow($script:app.MainWindowHandle, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
    $file = Join-Path $Work ("ui-{0:HHmmss}.png" -f (Get-Date)); $bmp.Save($file, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Host "Saved window capture $file"
  } catch { Write-Warning "Capture failed: $_" }
}

function WaitFor([string]$pattern, $type, [int]$seconds = 60) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    if ($script:app.HasExited) { throw "$product exited while waiting for '$pattern'" }
    $e = Find $pattern $type
    if ($e) { return $e }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
}

function Activate($e) {
  foreach ($pattern in [Windows.Automation.InvokePattern]::Pattern, [Windows.Automation.ExpandCollapsePattern]::Pattern) {
    $p = $null
    if ($e.TryGetCurrentPattern($pattern, [ref]$p)) {
      if ($p -is [Windows.Automation.InvokePattern]) { $p.Invoke() } else { $p.Expand() }
      return
    }
  }
  $b = $e.Current.BoundingRectangle
  $null = [FeedUiWindow]::SetCursorPos([int]($b.X + $b.Width / 2), [int]($b.Y + $b.Height / 2))
  [FeedUiWindow]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [FeedUiWindow]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}

function OpenAboutUpdates {
  $about = Find '^About & updates$' ([Windows.Automation.ControlType]::Button)
  if (!$about) {
    $settings = WaitFor '^Settings' ([Windows.Automation.ControlType]::Button) 60
    if ($settings) { Activate $settings } else { $null = Window; $shell.SendKeys('^,') }
    if (!(WaitFor '^Search settings$' $null 30)) { Dump 'settings did not open'; throw 'Settings did not open' }
    $about = WaitFor '^About & updates$' ([Windows.Automation.ControlType]::Button) 5
    if (!$about) {
      $group = WaitFor '^Maintenance$' $null 10
      if (!$group) { Dump 'no Maintenance group'; throw 'No Maintenance group in Settings' }
      Activate $group
      $about = WaitFor '^About & updates$' ([Windows.Automation.ControlType]::Button) 15
    }
  }
  if (!$about) { Dump 'no About & updates'; throw 'No About & updates section' }
  # Settings may still be laying out when the first click lands; confirm the page
  # changed by waiting for a heading only About & updates has.
  for ($try = 1; $try -le 3; $try++) {
    Activate $about
    if (WaitFor '^Build details & diagnostics$' $null 10) { return }
    $about = WaitFor '^About & updates$' ([Windows.Automation.ControlType]::Button) 10
    if (!$about) { break }
  }
  Dump 'About & updates did not open'; throw 'About & updates did not open'
}

$statusPattern = "^$([regex]::Escape($feed.version))\. "
function UpdateStatus([string]$want, [int]$seconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  $last = $null
  do {
    $e = Find $statusPattern $null
    if ($e) { $last = $e.Current.Name; if ($last -match $want) { return $last } }
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $deadline)
  Dump "status '$last' never matched '$want'"
  throw "Update status was '$last', expected /$want/"
}

# The trusted app refuses to start with APEX_*, ELECTRON_* or NODE_OPTIONS in its
# environment (desktop/provenance.mjs assertTrustedStartup). Start it the way a
# person does, without any the runner happens to set.
$scrubbed = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(APEX_|ELECTRON_)' -or $_.Name -eq 'NODE_OPTIONS' } | ForEach-Object Name)
$scrubbed | ForEach-Object { Remove-Item -LiteralPath "Env:$_" }
Evidence 'launch-env' @{ removed=$scrubbed }

try {
  # 4. Control: first launch with the app's own exe unable to reach the network.
  Step 'Control: launch with the app blocked from the network; its first check must fail'
  if (!(Get-Process -Name $product -ErrorAction SilentlyContinue)) { Start-Process -FilePath $exe }
  $script:app = MainWindowProcess
  # The app registers its own logon task on first launch; setup doesn't.
  $deadline = (Get-Date).AddMinutes(2)
  do { Start-Sleep -Milliseconds 500; $task = Get-ScheduledTask -TaskName $identity.WINDOWS_TASK -ErrorAction SilentlyContinue }
  until ($task.State -eq 'Running' -or (Get-Date) -gt $deadline)
  if ($task.State -ne 'Running') { throw "$($identity.WINDOWS_TASK) task is '$($task.State)', not Running" }
  Evidence 'launched' @{ pid=$script:app.Id; firewall='blocked'; task="$($task.State)" }
  OpenAboutUpdates
  # First automatic check runs 30 s after start.
  $blocked = UpdateStatus 'Couldn.t' 150
  Evidence 'blocked-check' @{ pid=$script:app.Id; status=$blocked }
  if ($blocked -match 'Up to date') { throw 'Up to date was reported without network access' }
  EndStep

  Step 'Unblock and click Check now; the app must read the feed and report Up to date'
  Remove-NetFirewallRule -DisplayName $rule
  $before = Get-Date
  $check = WaitFor '^Check now$' ([Windows.Automation.ControlType]::Button) 30
  if (!$check) { Dump 'no Check now'; throw 'No Check now button (updater disabled?)' }
  Activate $check
  $ok = UpdateStatus 'Up to date, checked' 120
  Evidence 'live-check' @{ pid=$script:app.Id; status=$ok; clickedAt=$before.ToUniversalTime().ToString('o') }
  if ($ok -match 'has no build|Couldn') { throw "Up to date carried an error: $ok" }
  $cache = @($env:APPDATA, $env:LOCALAPPDATA | ForEach-Object { Join-Path $_ "$($identity.PROFILE_ID)\updates\downloads" })
  $downloads = @($cache | ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -File -ErrorAction SilentlyContinue })
  Evidence 'no-download' @{ cache=$cache; files=$downloads.Count }
  if ($downloads.Count) { throw 'The app downloaded an update while on the newest build' }
  EndStep
  Write-Host "PASS: installed $product build $($feed.buildNumber) read $($identity.PRODUCT) feed and reported: $ok"
} catch {
  if ($script:app) { Dump "failure: $_" }
  throw
} finally {
  Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
}
