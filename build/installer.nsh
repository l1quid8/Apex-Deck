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
; The name comes from ReadEnvStr. Neither spelling of the environment token works
; here: nsExec launches taskkill.exe directly, so no cmd.exe turns %USERNAME% into
; a name, and NSIS has no $USERNAME variable at all -- makensis only warns 6000,
; drops it, and the filter then matches no process. electron-builder treats that
; warning as fatal, which is how this was caught rather than shipped.
;
; taskkill's exit code is thrown away, and that is the whole point of the loop
; below. Measured on windows-latest: without a /FI filter it answers 128 for "no
; such process", but as soon as a filter is present it answers 0 both for
; "terminated one" and for "nothing matched" -- so the exit code cannot tell
; those apart, and an earlier version of this loop spun its full 10 seconds and
; then refused to install on a machine that had never run Apex Deck. Whether the
; service is really gone is therefore asked of tasklist, which reports facts
; rather than a status code.
;
; tasklist is read as CSV and judged by its first character: a match starts with
; `"apex-daemon.exe"`, and the no-match line starts with "INFO:". The image name
; is never translated, the INFO text is, so this holds on any Windows language.
; Leading blank lines are skipped in case the runner adds one.
;
; Bounded at 20 x 500ms so a service that keeps respawning cannot hold the
; installer open forever. Leaves $R7 at the attempt count: 20 means it kept
; coming back, which is the only case that is the user's problem.
!macro StopDaemon
  nsExec::Exec '"$SYSDIR\schtasks.exe" /End /TN "${APEX_DAEMON_TASK}"'
  Pop $R0

  ReadEnvStr $R6 "USERNAME"
  StrCpy $R8 ""
  ${If} $R6 != ""
    StrCpy $R8 '/FI "USERNAME eq $R6"'
  ${EndIf}

  ; End any daemon the app started as its own child. Silent about the result:
  ; the check below is what decides whether it worked.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APEX_DAEMON_IMAGE}" $R8'
  Pop $R0

  StrCpy $R7 0
  ${If} $R8 != ""
    ${Do}
      nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APEX_DAEMON_IMAGE}" $R8 /FO CSV /NH'
      Pop $R0
      Pop $R1
      ; First non-blank character of the report -> $R9.
      ${Do}
        StrCpy $R9 $R1 1
        ${If} $R9 == "$\r"
        ${OrIf} $R9 == "$\n"
        ${OrIf} $R9 == " "
          StrCpy $R1 $R1 "" 1
        ${Else}
          ${ExitDo}
        ${EndIf}
      ${Loop}
      ${If} $R9 != '"'
        ${ExitDo}
      ${EndIf}
      IntOp $R7 $R7 + 1
      ${If} $R7 >= 20
        ${ExitDo}
      ${EndIf}
      Sleep 500
      nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APEX_DAEMON_IMAGE}" $R8'
      Pop $R0
    ${Loop}
  ${EndIf}
!macroend

!macro customInit
  !insertmacro StopDaemon

  ; Say what to do instead of failing later with a locked-file error nobody can
  ; read. Silent installs skip the box but must not skip the failure: reporting
  ; success and then leaving a locked image behind is how an unattended upgrade
  ; breaks with nothing in the log to explain it.
  ${If} $R7 >= 20
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "Apex Deck's background service keeps restarting, so this version cannot replace it.$\n$\nClose Apex Deck, end apex-daemon.exe on Task Manager's Details tab, then run this installer again."
    ${EndIf}
    SetErrorLevel 2
    Quit
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
