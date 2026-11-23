# CI-only: sign the programs inside the unpacked app before the installer wraps
# them. Runs apart from the build, so build code never holds the Azure login.
param([Parameter(Mandatory=$true)][string]$Unpacked)
$ErrorActionPreference='Stop'
$Unpacked=(Resolve-Path $Unpacked).Path
Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser
$channels = Get-Content -Raw (Join-Path $PSScriptRoot '../desktop/channels.json') | ConvertFrom-Json
$name = if ($null -eq $env:APEX_CHANNEL) { 'stable' } else { $env:APEX_CHANNEL }
if ($name -cnotin @('stable', 'nightly')) { throw 'APEX_CHANNEL must be stable or nightly' }
$channel = $channels.$name
$files=@("$($channel.PRODUCT).exe","resources\bin\$($channel.WINDOWS_DAEMON)","resources\bin\$($channel.WINDOWS_HELPER)") |
  ForEach-Object { Join-Path $Unpacked $_ }
foreach ($file in $files) {
  if (-not (Test-Path $file)) { throw "nothing to sign at $file" }
  Invoke-TrustedSigning -Endpoint 'https://eus.codesigning.azure.net' -CodeSigningAccountName 'apexdecksigning' `
    -CertificateProfileName 'apexdeckpublic' -Files $file -FileDigest SHA256 `
    -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256
}
