; Apex Deck's NSIS additions. electron-builder includes this file and calls
; `customInit` inside .onInit (before any file is copied) and `customUnInstall`
; at the start of the uninstaller, before the installed files are removed.
;
; Why this exists: since M3 the app starts its background service
; (apex-daemon.exe) from a Task Scheduler logon task, so the daemon outlives the
; app window. Windows keeps the image of a running program locked, so installing
; a newer build over an older one cannot replace resources\bin\apex-daemon.exe.
; It also leaves an old service answering the pipe, and on Windows the app skips
; registering the new sign-in task while something is still answering. Stopping
; the service first fixes both.

!include "LogicLib.nsh"

!define APEX_DAEMON_TASK "ApexDeckDaemon"
!define APEX_DAEMON_IMAGE "apex-daemon.exe"

; Stop the previous build's service: end the scheduled task, then end any daemon
; the app started itself as a child. taskkill exits 128 when there is no such
; process, which is how this loop knows it is done; anything else means a
; process was still there (or still dying), so ask again. Bounded at 20 x 500ms
; so a daemon that refuses to exit cannot hold the installer open forever.
; Leaves $R1 at the attempt count: 20 means it never went away.
!macro StopDaemon
  nsExec::Exec '"$SYSDIR\schtasks.exe" /End /TN "${APEX_DAEMON_TASK}"'
  Pop $R0

  StrCpy $R1 0
  ${Do}
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APEX_DAEMON_IMAGE}"'
    Pop $R0
    ${If} $R0 == "128"
      ${ExitDo}
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 20
      ${ExitDo}
    ${EndIf}
    Sleep 500
  ${Loop}
!macroend

!macro customInit
  !insertmacro StopDaemon

  ; Say what to do instead of failing later with a locked-file error nobody can
  ; read. Silent installs skip the box: an unattended upgrade should report the
  ; failure through its exit code, not wait on a dialog.
  ${If} $R1 >= 20
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "Apex Deck's background service is still running, so this version cannot replace it.$\n$\nClose Apex Deck, end apex-daemon.exe on Task Manager's Details tab, then run this installer again."
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; An uninstall must not fail on a running image either, and a logon task left
  ; behind would point at a binary that is about to be deleted.
  !insertmacro StopDaemon
!macroend
