# Run only on the disposable installer CI runner. The public release uses its own publisher check.
param(
  [Parameter(Mandatory)][string]$PreviousSetup,
  [Parameter(Mandatory)][string]$CurrentSetup,
  [Parameter(Mandatory)][string]$App,
  [Parameter(Mandatory)][long]$PreviousBuild,
  [Parameter(Mandatory)][long]$CurrentBuild
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:APEX_DECK_WIN_SIGN -eq '1') {
  throw 'This QA test requires an unsigned build on a disposable GitHub-hosted Windows runner.'
}

$tempRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$id = [guid]::NewGuid().ToString()
$scratch = (New-Item -ItemType Directory -Path (Join-Path $tempRoot "nightly-authenticode-$id")).FullName
$certificate = $null
$oldChannel = $env:APEX_CHANNEL
try {
  $copies = [ordered]@{ 'previous.exe' = $PreviousSetup; 'current.exe' = $CurrentSetup; 'app.exe' = $App }
  foreach ($copy in $copies.GetEnumerator()) {
    Copy-Item -LiteralPath $copy.Value -Destination (Join-Path $scratch $copy.Key)
  }
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Apex Deck Nightly QA $id, O=Apex Deck CI" `
    -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddHours(1)
  $public = Join-Path $scratch 'qa.cer'
  Export-Certificate -Cert $certificate -FilePath $public | Out-Null
  Import-Certificate -FilePath $public -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  foreach ($name in $copies.Keys) {
    $signed = Set-AuthenticodeSignature -LiteralPath (Join-Path $scratch $name) -Certificate $certificate -HashAlgorithm SHA256
    if ($signed.Status -ne 'Valid' -or $signed.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
      throw "QA signing failed for $name ($($signed.Status): $($signed.StatusMessage))"
    }
  }
  $env:APEX_CHANNEL = 'nightly'
  node "$PSScriptRoot/windows-nightly-authenticode-qa.mjs" $scratch $PreviousBuild $CurrentBuild
  if ($LASTEXITCODE) { throw 'Nightly Authenticode updater test failed' }
} finally {
  $env:APEX_CHANNEL = $oldChannel
  try {
    if ($certificate) {
      $trusted = "Cert:\LocalMachine\Root\$($certificate.Thumbprint)"
      try {
        if (Test-Path -LiteralPath $trusted) { Remove-Item -LiteralPath $trusted -Force }
      } finally {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey -Force
      }
    }
  } finally {
    $target = (Resolve-Path -LiteralPath $scratch).Path
    if ($target -ne (Join-Path $tempRoot "nightly-authenticode-$id")) { throw 'Unexpected QA cleanup path' }
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}
