param(
  [Parameter(Mandatory=$true)][string]$ApkPath,
  [string]$DevEcoRoot=$env:DEVECO_STUDIO_HOME
)
$ErrorActionPreference='Stop'
if (!$DevEcoRoot) { throw 'Set DEVECO_STUDIO_HOME or provide -DevEcoRoot for your DevEco installation' }
$projectRoot=Split-Path -Parent $PSScriptRoot
$assetDir=Join-Path $projectRoot 'entry\src\main\resources\rawfile\offline-mfi'
New-Item -ItemType Directory -Path $assetDir -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ApkPath).Path)
try {
  foreach($name in @('identity.pk8','certificate.p7b')) {
    $entry=$archive.GetEntry('assets/offline-mfi/'+$name)
    if(!$entry -or $entry.Length -lt 1 -or $entry.Length -gt 16384){throw 'Missing or oversized APK experimental identity'}
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $assetDir $name),$true)
  }
} finally { $archive.Dispose() }
$certs=[System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
$certs.Import([System.IO.File]::ReadAllBytes((Join-Path $assetDir 'certificate.p7b')))
if($certs.Count -ne 1){throw 'Expected one accessory certificate'}
$public=[System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPublicKey($certs[0])
try {
  if(!$public -or $public.KeySize -ne 256){throw 'Expected P-256 certificate'}
  [System.IO.File]::WriteAllBytes((Join-Path $assetDir 'public-key.der'),$public.ExportSubjectPublicKeyInfo())
} finally { if($public){$public.Dispose()};$certs[0].Dispose() }
& (Join-Path $DevEcoRoot 'tools\node\node.exe') (Join-Path $PSScriptRoot 'check-auth-key.cjs') $assetDir
if($LASTEXITCODE -ne 0){throw 'Experimental identity key consistency check failed'}
Write-Output 'Imported local experimental APK material. This is separate from HAP developer signing.'
