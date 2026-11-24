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
!include "getProcessInfo.nsh"
Var pid

!define APEX_INSTALL_DIR "$PROGRAMFILES64\${PRODUCT_FILENAME}"

; The Windows packager supplies these identities from desktop/channels.json.
; Direct builds with the repository's Stable electron-builder.yml keep the
; historic names. A different app ID must supply its own identities.
!ifndef APEX_DAEMON_TASK
  !if "${APP_ID}" != "dev.apexdeck.app"
    !error "Missing channel identities for ${APP_ID}"
  !endif
  !define APEX_DAEMON_TASK "ApexDeckDaemon"
  !define APEX_DAEMON_IMAGE "apex-daemon.exe"
  !define APEX_SERVICE "ApexDeckProvenance"
  !define APEX_HELPER_IMAGE "apex-provenance.exe"
!endif

!macro RefuseInstallLocation REASON
  DetailPrint "${REASON}"
  MessageBox MB_ICONSTOP|MB_OK "${REASON}" /SD IDOK
  SetErrorLevel 2
  Quit
!macroend

; Both channels ship only per-machine x64 installations. The assisted NSIS
; template resolves /D= and old registrations even with no directory page.
!macro PinInstallLocation
  ${If} $INSTDIR != "${APEX_INSTALL_DIR}"
    !insertmacro RefuseInstallLocation "${PRODUCT_NAME} requires the installation folder ${APEX_INSTALL_DIR}."
  ${EndIf}
  StrCpy $INSTDIR "${APEX_INSTALL_DIR}"
!macroend

!macro CheckInstallRegistration
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !error "An additional uninstall key requires its own location check"
  !endif
  ReadRegStr $R4 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R5 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R4 != ""
  ${OrIf} $R5 != ""
    !insertmacro RefuseInstallLocation "${PRODUCT_NAME} has a conflicting per-user installation. Remove that registration before continuing."
  ${EndIf}

  ReadRegStr $R4 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R5 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R4 != ""
  ${OrIf} $R5 != ""
    ${If} $R4 != "${APEX_INSTALL_DIR}"
    ${OrIf} $R5 != '"${APEX_INSTALL_DIR}\${UNINSTALL_FILENAME}" /allusers'
    ${OrIfNot} ${FileExists} "${APEX_INSTALL_DIR}\${UNINSTALL_FILENAME}"
      !insertmacro RefuseInstallLocation "${PRODUCT_NAME}'s registered installation folder or uninstaller is incorrect. Repair its registration before continuing."
    ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
  !include "${PROJECT_DIR}\build\channelProcesses.nsh"
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !include "${PROJECT_DIR}\build\machineUpgrade.nsh"
  !else
    ; A silent uninstall checks running apps before un.onInit resolves the
    ; install mode. Never feed its initial caller-supplied path to PowerShell.
    !insertmacro GetDParameter $R3
    ${If} $R3 != ""
    ${AndIf} $R3 != "${APEX_INSTALL_DIR}"
      !insertmacro RefuseInstallLocation "${PRODUCT_NAME} requires the installation folder ${APEX_INSTALL_DIR}."
    ${EndIf}
    !insertmacro PinInstallLocation
    !insertmacro CheckInstallRegistration
  !endif
  ; NSIS strips trailing separators when it expands $INSTDIR. Pass a literal
  ; separator outside the variable, as data to the child PowerShell process.
  System::Call 'kernel32::SetEnvironmentVariableW(w "APEX_NSIS_PROCESS_DIR", w "${APEX_INSTALL_DIR}\") i.r0'
  ${If} $0 == 0
    !insertmacro RefuseInstallLocation "Could not resolve the running processes for ${PRODUCT_NAME}."
  ${EndIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  System::Call 'kernel32::SetEnvironmentVariableW(w "APEX_NSIS_PROCESS_DIR", p 0)'
!macroend

!macro customUnInit
  !insertmacro PinInstallLocation
  !insertmacro CheckInstallRegistration
!macroend

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
  !insertmacro PinInstallLocation
  !insertmacro CheckInstallRegistration
  ; Stop the protected service before replacing its executable or pinned UI.
  ; A first install has no service; sc returns 1060 and needs no repair.
  ; A kill counts as a crash, so Windows would restart the service mid-install:
  ; wait for it to stop on request, and kill it only if it never does.
  StrCpy $R6 0
  ${Do}
    nsExec::Exec '"$SYSDIR\sc.exe" stop "${APEX_SERVICE}"'
    Pop $R5
    nsExec::Exec '"$SYSDIR\sc.exe" query "${APEX_SERVICE}"'
    Pop $R5
    ${If} $R5 != 0
      ${ExitDo}
    ${EndIf}
    nsExec::Exec `"$SYSDIR\cmd.exe" /c ""$SYSDIR\sc.exe" query "${APEX_SERVICE}" | "$SYSDIR\find.exe" "STOPPED""`
    Pop $R5
    ${If} $R5 == 0
      ${ExitDo}
    ${EndIf}
    IntOp $R6 $R6 + 1
    ${If} $R6 >= 60
      nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APEX_HELPER_IMAGE}"'
      Pop $R5
      ${ExitDo}
    ${EndIf}
    Sleep 500
  ${Loop}
  !insertmacro StopDaemon

  ; Say what to do instead of failing later with a locked-file error nobody can
  ; read. Silent installs skip the box but must not skip the failure: reporting
  ; success and then leaving a locked image behind is how an unattended upgrade
  ; breaks with nothing in the log to explain it.
  ${If} $R7 >= 20
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "${PRODUCT_NAME}'s background service keeps restarting, so this version cannot replace it.$\n$\nClose ${PRODUCT_NAME}, end ${APEX_DAEMON_IMAGE} on Task Manager's Details tab, then run this installer again."
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInstall
  nsExec::ExecToStack '"$INSTDIR\resources\bin\${APEX_HELPER_IMAGE}" install'
  Pop $R2
  Pop $R1
  ${If} $R2 != 0
    DetailPrint "$R1"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "${PRODUCT_NAME} could not install its protected authority service.$\n$\n$R1"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstall
  ; An update replaces files and reinstalls over this service. Deleting it here
  ; would leave Deck without one if removing the old files then failed.
  ${IfNot} ${isUpdated}
    nsExec::Exec '"$INSTDIR\resources\bin\${APEX_HELPER_IMAGE}" uninstall'
    Pop $R0
  ${EndIf}
  ; An uninstall must not fail on a running image either, and the logon task must
  ; go too: left behind it would point at a binary this is about to delete, and
  ; fail at every sign-in from then on. Ending it is not enough, so remove the
  ; definition as well.
  !insertmacro StopDaemon
  ${IfNot} ${isUpdated}
    nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "${APEX_DAEMON_TASK}" /F'
    Pop $R0
  ${EndIf}
!macroend
