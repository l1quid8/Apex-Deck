# CI-only: sign the programs inside the unpacked app before the installer wraps
# them. Runs apart from the build, so build code never holds the Azure login.
param([Parameter(Mandatory=$true)][string]$Unpacked)
$ErrorActionPreference='Stop'
$Unpacked=(Resolve-Path $Unpacked).Path
Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser
$files=@('Apex Deck.exe','resources\elevate.exe','resources\bin\apex-daemon.exe','resources\bin\apex-provenance.exe') |
  ForEach-Object { Join-Path $Unpacked $_ }
foreach ($file in $files) {
  if (-not (Test-Path $file)) { throw "nothing to sign at $file" }
  Invoke-TrustedSigning -Endpoint 'https://eus.codesigning.azure.net' -CodeSigningAccountName 'apexdecksigning' `
    -CertificateProfileName 'apexdeckpublic' -Files $file -FileDigest SHA256 `
    -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256
}
