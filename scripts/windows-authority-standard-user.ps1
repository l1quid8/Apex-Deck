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
  @"
`$env:TEMP=`$PSScriptRoot
`$env:TMP=`$PSScriptRoot
& '$nodeLiteral' '$smokeLiteral' '$daemonLiteral'
exit `$LASTEXITCODE
"@ | Set-Content -Path $script -Encoding utf8
  $credential=[PSCredential]::new("$env:COMPUTERNAME\$name",$password)
  $process=Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -WorkingDirectory $probe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$script+'"') -RedirectStandardOutput (Join-Path $probe 'stdout.txt') -RedirectStandardError (Join-Path $probe 'stderr.txt') -PassThru
  if (-not $process.WaitForExit(180000)) { $process.Kill();throw 'standard-user authority smoke timed out' }
  Get-Content (Join-Path $probe 'stdout.txt')
  Get-Content (Join-Path $probe 'stderr.txt')
  if ($process.ExitCode -ne 0) { throw "standard-user production authority failed: exit $($process.ExitCode)" }
} finally {
  if ($user) { Remove-LocalUser -Name $name }
  if (Test-Path $probe) { Remove-Item -Recurse -Force $probe }
}
