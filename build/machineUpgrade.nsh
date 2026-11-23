; installSection.nsh normally runs a second old uninstaller from HKCU after
; the HKLM upgrade. A user can change that registration while Setup is open.
; At the point the section is compiled, keep its standard machine upgrade
; and skip the per-user pass. Both channels have always installed per-machine.
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  !if "${ROOT_KEY}" == "SHELL_CONTEXT"
    Push "HKEY_LOCAL_MACHINE"
    Call uninstallOldVersion
  !else if "${ROOT_KEY}" == "HKEY_CURRENT_USER"
    ClearErrors
    StrCpy $R0 0
  !else
    !error "Unexpected upgrade registry root ${ROOT_KEY}"
  !endif
!macroend
