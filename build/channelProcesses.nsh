; Preserve electron-builder's prompts, retries, and exact image fallback.
; Its default PowerShell filter matches "Apex Deck Nightly" under "Apex Deck".
!define APEX_PROCESSES 'Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$env:APEX_NSIS_PROCESS_DIR, [StringComparison]::OrdinalIgnoreCase) }'

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
