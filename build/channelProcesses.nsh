; Preserve electron-builder's prompts, retries, and exact image fallback.
; Its default PowerShell filter matches "Apex Deck Nightly" under "Apex Deck".
; The stock check supplies its PID. An in-place uninstaller runs from this
; same directory and must stay alive to finish removing the application.
; The daemon and the protected service also run from here, but this check is
; for the app window. installer.nsh stops those two in order (StopDaemon,
; StopAuthorityForInstall, the uninstall helper); killing the service here would
; count as a crash, and Windows would restart it while files are replaced.
; Their image names arrive in APEX_NSIS_SERVICE_IMAGES, comma-separated: this
; command already sits inside double and back quotes, so it cannot quote them.
!define APEX_PROCESSES 'Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $pid -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$env:APEX_NSIS_PROCESS_DIR, [StringComparison]::OrdinalIgnoreCase) -and (($$env:APEX_NSIS_SERVICE_IMAGES -split [char]44) -notcontains $$_.Name) }'

!macroundef FIND_PROCESS
!macro FIND_PROCESS IMAGE RESULT
  ${If} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -Command "if (@(${APEX_PROCESSES}).Count) { exit 0 } else { exit 1 }"`
    Pop ${RESULT}
  ${Else}
    ${nsProcess::FindProcess} "${IMAGE}" ${RESULT}
  ${EndIf}
!macroend

!macroundef KILL_PROCESS
!macro KILL_PROCESS IMAGE FORCE
  ${If} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -Command "${APEX_PROCESSES} | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force:([bool]${FORCE}) }"`
    Pop $R4
  ${Else}
    !if ${FORCE} == 1
      ${nsProcess::KillProcess} "${IMAGE}" $R4
    !else
      ${nsProcess::CloseProcess} "${IMAGE}" $R4
    !endif
  ${EndIf}
!macroend
