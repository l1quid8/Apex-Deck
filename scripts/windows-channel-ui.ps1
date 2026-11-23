# Run only against the fresh profiles on the disposable channel lifecycle VM.
param(
  [Parameter(Mandatory)][ValidateSet('stable','nightly')][string]$Channel,
  [Parameter(Mandatory)][int]$AppId,
  [switch]$CreateSample,
  [string]$Post,
  [string[]]$Expect = @(),
  [string[]]$Exclude = @()
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$identity = (Get-Content "$PSScriptRoot/../desktop/channels.json" -Raw | ConvertFrom-Json).$Channel
$install = Join-Path $env:ProgramFiles $identity.PRODUCT
$app = Get-Process -Id $AppId
# Snapshot supplies the main PID after checking the Start shortcut and install
# pins. Process protection can hide MainModule.Path from the current account.
if ($app.ProcessName -ne $identity.PRODUCT -or ($app.Path -and $app.Path -ne (Join-Path $install "$($identity.PRODUCT).exe"))) {
  throw "Wrong UI executable for $Channel at PID $AppId"
}
if (!$Post -and !$Expect.Count) { throw 'Supply a marker to post or recover.' }
Write-Host "Testing $Channel UI PID $AppId in Windows session $($app.SessionId) as $([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"

function Find-Control([string]$name, $type) {
  $app.Refresh()
  if ($app.MainWindowHandle -eq [IntPtr]::Zero) { return }
  $window = [Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
  $condition = [Windows.Automation.AndCondition]::new(
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $type))
  $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Wait-Control([string]$name, $type) {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    if ($app.HasExited) { throw "$Channel UI PID $AppId exited while looking for '$name'" }
    try {
      $element = Find-Control $name $type
      if ($element -and $element.Current.IsEnabled) { return $element }
    } catch [Windows.Automation.ElementNotAvailableException] { }
    Start-Sleep -Milliseconds 300
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "UI Automation could not find enabled '$name' in $Channel PID $AppId, HWND $($app.MainWindowHandle), session $($app.SessionId)"
}

function Invoke-Button([string]$name) {
  $button = Wait-Control $name ([Windows.Automation.ControlType]::Button)
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

if ($CreateSample) { Invoke-Button 'Try a sample thread' }
if ($Post) {
  $inputBox = Wait-Control 'Message the room' ([Windows.Automation.ControlType]::Edit)
  $value = $inputBox.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
  if ($value.Current.Value) { throw "Unexpected existing draft in $Channel" }
  $value.SetValue($Post)
  # The composer ignores clicks for 600 ms after switching threads.
  Start-Sleep -Milliseconds 700
  Invoke-Button 'Send'
  $Expect += $Post
}
foreach ($marker in $Expect) {
  $null = Wait-Control $marker ([Windows.Automation.ControlType]::Text)
}

# Only the packaged UI submits changes. Read the installed daemon's catalog
# and authoritative transcript to distinguish a saved post from UI draft text.
$daemon = Join-Path $install "resources/bin/$($identity.WINDOWS_DAEMON)"
function Read-Reply([string]$command, [hashtable]$arguments) {
  $request = @{id=41; cmd=$command; args=$arguments} | ConvertTo-Json -Compress
  $frames = @('{"id":0,"cmd":"hello","args":{"protocol":1}}', $request)
  $response = $frames | & $daemon --stdio --attach --data-dir (Join-Path $env:APPDATA $identity.PRODUCT)
  if ($LASTEXITCODE) { throw "Read-only $Channel daemon attachment exited with $LASTEXITCODE" }
  $reply = @($response | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object id -eq 41)
  if ($reply.Count -ne 1 -or $null -eq $reply[0].ok) { throw "No successful $command reply from $Channel" }
  return $reply[0].ok
}
$matchesByRoom = @(
  foreach ($room in (Read-Reply 'chat_list' @{}).rooms) {
    $snapshot = (Read-Reply 'room_state' @{id=$room.id}).snapshot
    if ($null -eq $snapshot.transcript) { throw "$Channel thread $($room.id) returned no transcript" }
    $humanPosts = @($snapshot.transcript | Where-Object { $_.speaker.kind -eq 'human' } | ForEach-Object text)
    foreach ($marker in $Exclude) {
      if ($humanPosts -ccontains $marker) { throw "$Channel thread $($room.id) contains the other channel's '$marker'" }
    }
    $missing = @($Expect | Where-Object { $humanPosts -cnotcontains $_ })
    if ($room.kind -eq 'work' -and !$missing.Count) { $room }
  }
)
if ($matchesByRoom.Count -ne 1) {
  throw "Expected one saved $Channel Work thread containing '$($Expect -join ', ')', found $($matchesByRoom.Count)"
}
$room = $matchesByRoom[0]
Write-Host (@{channel=$Channel; app=$AppId; room=$room.id; title=$room.title; present=$Expect; absent=$Exclude} | ConvertTo-Json -Compress)
