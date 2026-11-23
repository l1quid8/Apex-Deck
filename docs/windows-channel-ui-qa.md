# Windows Stable and Nightly interactive acceptance

Run on a disposable Windows 11 VM, signed in as the same ordinary user for both apps. Record the installer hashes, source commits, build numbers, Windows version and user SID. Use empty local project folders inside the VM. The scripted agent preset works offline.

## Default folders and opposite-channel upgrades

1. Launch both apps from their own Start menu shortcuts with the default data folders. In each app, add a different local project folder. Under **Threads**, use the project's **New thread** action. Add a **Scripted (no model, for testing)** participant and post a unique marker, such as `stable-initial-<run>` or `nightly-initial-<run>`. Wait for each marker to appear in its transcript. Record the title, marker and owning channel.
2. Quit both UIs completely. Relaunch both from their shortcuts. Open each saved thread and check its transcript. Search both apps for both markers. Each app must recover its own marker, and a search for the other channel's marker must yield no match.
3. Leave Stable open while upgrading Nightly to its higher build. In that same Stable window, post a new unique marker to the original thread and wait for it to appear. In the upgraded Nightly, open its original thread and post a different marker. Quit and relaunch both apps and check that both transcripts retain their respective messages. Record the results and installed versions.
4. Repeat step 3 with Nightly left open while upgrading Stable. Use fresh messages in both apps and repeat the relaunch and isolation checks. Save screenshots of the app versions and the recovered transcripts. A window that displays an optimistic message but loses it on relaunch fails this check.

## A genuine installed receipt presented to the other daemon

The following test uses an explicitly selected, fresh QA data folder. A packaged UI obtains its receipt from its own installed authority and sends it to the daemon already serving that folder. The receiver checks the signature using its own protected public key. The ordinary signed binaries, both authority services and their public-key checks stay active throughout.

Quit both UIs after the default-folder tests. Open a fresh PowerShell in the repository on the VM. Run the following blocks twice, once for each value of `$receiving`. Start each run from a clean PowerShell without Apex or Electron development overrides.

```powershell
$receiving = 'stable'    # On the second run, use 'nightly'.
$sending = if ($receiving -eq 'stable') { 'nightly' } else { 'stable' }
$channels = Get-Content -Raw -LiteralPath desktop/channels.json | ConvertFrom-Json
$qaData = Join-Path $env:TEMP ("ApexReceipt-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $qaData | Out-Null
$receiveRoot = Join-Path $env:ProgramFiles $channels.$receiving.PRODUCT
$qaDaemon = Join-Path $receiveRoot ("resources\bin\" + $channels.$receiving.WINDOWS_DAEMON)
$daemonStart = New-Object System.Diagnostics.ProcessStartInfo
$daemonStart.FileName = $qaDaemon
$daemonStart.Arguments = 'serve --exit-on-stdin-close --data-dir "' + $qaData + '"'
$daemonStart.UseShellExecute = $false
$daemonStart.CreateNoWindow = $true
$daemonStart.RedirectStandardInput = $true
$receiver = [Diagnostics.Process]::Start($daemonStart)
$readyFile = Join-Path $qaData 'daemon.json'
$deadline = [DateTime]::UtcNow.AddSeconds(60)
do {
    if ($receiver.HasExited) { throw "Receiver exited with code $($receiver.ExitCode)." }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Receiver did not become ready.' }
    Start-Sleep -Milliseconds 250
    $ready = try { Get-Content -Raw -LiteralPath $readyFile -ErrorAction Stop | ConvertFrom-Json } catch { $null }
} until ($ready.pid -eq $receiver.Id)
"Receiving daemon $qaDaemon, PID $($receiver.Id), endpoint $($ready.socket), scope $qaData"

function Open-QAWindow([string]$name) {
    $product = $channels.$name.PRODUCT
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path (Join-Path $env:ProgramFiles $product) "$product.exe"
    $start.UseShellExecute = $false
    $start.EnvironmentVariables['APEX_DECK_DATA_DIR'] = $qaData
    $windowProcess = [Diagnostics.Process]::Start($start)
    "Opened $($start.FileName), PID $($windowProcess.Id)"
}

function Get-QARooms {
    if ($receiver.HasExited) { throw 'Receiving daemon exited during the test.' }
    $frames = @('{"id":0,"cmd":"hello","args":{"protocol":1}}', '{"id":41,"cmd":"chat_list","args":{}}')
    $out = $frames | & $qaDaemon --stdio --attach --data-dir $qaData
    if ($LASTEXITCODE -ne 0) { throw 'Read-only attachment to the receiving daemon failed.' }
    $reply = $out | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object id -eq 41
    if ($null -eq $reply.ok.rooms -or $reply.err) { throw "chat_list failed: $($reply.err)" }
    $reply.ok.rooms | Select-Object id, title, kind, trashedAt
}
Open-QAWindow $receiving
```

1. In the receiver's window, create a local project Work thread with a unique title and a scripted participant. Post a marker. Run `Get-QARooms` and record the receiver's row ID and its empty `trashedAt`. Creating this persistent room exercises a protected submission on the same channel. Quit the UI and keep the receiving daemon running.
2. Run `Open-QAWindow $sending`. Open the same QA thread, use its menu and select **Move to Trash**. This action calls the protected `room_set_trashed` command. Capture the exact error **Invalid provenance signature** and the receiver PID. Run `Get-QARooms` and verify that the recorded ID still has an empty `trashedAt`. A missing service, denied peer, unavailable thread, different error or missing row leaves the receipt check unverified.
3. Quit the sending UI. Run `Open-QAWindow $receiving`, select **Move to Trash** on the same row and run `Get-QARooms` again. The same ID must now have a positive `trashedAt`. Restore it from **Trash** and verify its marker survives. This exercises the identical operation on the receiving daemon with a freshly issued same-channel receipt.
4. Quit the UI. Close the test daemon's input and wait for that exact process to exit. Repeat with the opposite receiver and a new folder.

```powershell
$receiver.StandardInput.Close()
if (!$receiver.WaitForExit(30000)) { throw 'The QA daemon did not exit after its input closed.' }
```

Record a row for each direction with the UI executable, receiving daemon executable and PID, QA room ID, exact error, before/after Trash state and same-channel control result. Keep both installed-receipt runs separate from the broker unit test, which independently checks a mismatched signing key and a valid signature over the other channel's domain.
