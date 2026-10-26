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
; the app started itself as a child.
;
; The taskkill filter keeps this to our own user. /IM alone matches every user's
; copy, and on a shared PC we may neither end somebody else's nor count it as our
; problem -- that is how you get "the service is still running" when nothing of
; ours is running at all.
;
; It must be $USERNAME, not %USERNAME%: nsExec launches taskkill.exe directly, so
; nothing turns %USERNAME% into a name. It would reach the filter as literal
; text, match no process, and quietly skip the daemon we came to stop. (cmd.exe
; is what expands %USERNAME%, and we do not run through it.)
;
; The loop repeats only while taskkill reports success, i.e. while it keeps
; finding a copy to end. Any other result -- no such process, or another user's
; process we may not touch -- means there is nothing left for us to do, so it
; stops instead of guessing which exit code means "not found". Bounded at 20 x
; 500ms so a service that keeps respawning cannot hold the installer open
; forever. Leaves $R1 at the attempt count: 20 means it kept coming back.
!macro StopDaemon
  nsExec::Exec '"$SYSDIR\schtasks.exe" /End /TN "${APEX_DAEMON_TASK}"'
  Pop $R0

  StrCpy $R1 0
  ${Do}
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APEX_DAEMON_IMAGE}" /FI "USERNAME eq $USERNAME"'
    Pop $R0
    ${If} $R0 != "0"
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
      MessageBox MB_ICONSTOP|MB_OK "Apex Deck's background service keeps restarting, so this version cannot replace it.$\n$\nClose Apex Deck, end apex-daemon.exe on Task Manager's Details tab, then run this installer again."
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; An uninstall must not fail on a running image either, and the logon task must
  ; go too: left behind it would point at a binary this is about to delete, and
  ; fail at every sign-in from then on. Ending it is not enough, so remove the
  ; definition as well.
  !insertmacro StopDaemon
  nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "${APEX_DAEMON_TASK}" /F'
  Pop $R0
!macroend
