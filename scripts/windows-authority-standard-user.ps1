# CI-only: verify production IPC without administrator or SeDebugPrivilege rights.
param([Parameter(Mandatory=$true)][string]$Daemon)
$ErrorActionPreference='Stop'
$name='apexauth'+[guid]::NewGuid().ToString('N').Substring(0,8)
$password=ConvertTo-SecureString ([guid]::NewGuid().ToString('N')+'aA!9') -AsPlainText -Force
$probe=Join-Path $env:PUBLIC ('ApexAuthorityProbe-'+[guid]::NewGuid().ToString('N'))
$user=$null
try {
  $user=New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires
  $users=Get-LocalGroup -SID 'S-1-5-32-545'
  Add-LocalGroupMember -Group $users -Member $user
  New-Item -ItemType Directory -Path $probe | Out-Null
  & icacls.exe $probe /grant "${name}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not prepare the standard-user test directory' }
  $node=(Get-Command node.exe).Source
  $smoke=Join-Path $PSScriptRoot 'windows-authority-smoke.mjs'
  $script=Join-Path $probe 'run.ps1'
  # Inputs are local trusted build paths; PowerShell literals double apostrophes.
  $nodeLiteral=$node.Replace("'","''")
  $smokeLiteral=$smoke.Replace("'","''")
  $daemonLiteral=$Daemon.Replace("'","''")
  $helperLiteral=(Join-Path (Split-Path $Daemon) 'apex-provenance.exe').Replace("'","''")
  @"
`$env:TEMP=`$PSScriptRoot
`$env:TMP=`$PSScriptRoot
& '$nodeLiteral' '$smokeLiteral' '$daemonLiteral'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
try {
  `$rogue=[System.IO.Pipes.NamedPipeServerStream]::new('ApexDeckProvenance-v1','InOut',-1)
  `$rogue.Dispose()
  Write-Output 'a standard user added a server end to the authority pipe'
  exit 9
} catch {
  if (`$_.Exception.InnerException -isnot [UnauthorizedAccessException]) { Write-Output `$_; exit 10 }
}
`$held=Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' -WindowStyle Hidden -PassThru
& '$helperLiteral' protect-process `$held.Id
if (`$LASTEXITCODE -ne 0) { Write-Output 'protect-process failed'; exit 11 }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ApexProbe { [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid); }'
foreach (`$access in 0x20,0x2,0x40000) {
  if ([ApexProbe]::OpenProcess(`$access,`$false,`$held.Id) -ne [IntPtr]::Zero) { Write-Output "a standard user opened a protected process with `$access"; exit 12 }
}
if ([ApexProbe]::OpenProcess(0x100000,`$false,`$held.Id) -eq [IntPtr]::Zero) { Write-Output 'a protected process could not be waited on'; exit 13 }
& taskkill.exe /PID `$held.Id /F | Out-Null
exit 0
"@ | Set-Content -Path $script -Encoding utf8
  $credential=[PSCredential]::new("$env:COMPUTERNAME\$name",$password)
  $process=Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -WorkingDirectory $probe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$script+'"') -RedirectStandardOutput (Join-Path $probe 'stdout.txt') -RedirectStandardError (Join-Path $probe 'stderr.txt') -PassThru
  if (-not $process.WaitForExit(180000)) { $process.Kill();throw 'standard-user authority smoke timed out' }
  Get-Content (Join-Path $probe 'stdout.txt')
  Get-Content (Join-Path $probe 'stderr.txt')
  if ($process.ExitCode -ne 0) { throw "standard-user production authority failed: exit $($process.ExitCode)" }
  $locks=Join-Path $env:ProgramData "Apex Deck Provenance\users\$($user.SID.Value)\host-locks-v2"
  $sddl=(Get-Acl $locks).Sddl
  if ($sddl -match ';BU\)' -or $sddl -notmatch [regex]::Escape($user.SID.Value)) { throw "host locks are open to other accounts: $sddl" }
} finally {
  if ($user) { Remove-LocalUser -Name $name }
  if (Test-Path $probe) { Remove-Item -Recurse -Force $probe }
}
