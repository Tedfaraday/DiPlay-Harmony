param([string]$DevEcoRoot = $env:DEVECO_STUDIO_HOME)
$ErrorActionPreference = 'Stop'
if (!$DevEcoRoot) { throw 'Set DEVECO_STUDIO_HOME or provide -DevEcoRoot for your DevEco installation' }
$projectPath = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $DevEcoRoot 'tools\node\node.exe'
$wrapperPath = Join-Path $DevEcoRoot 'tools\hvigor\bin\hvigorw.js'
if (!(Test-Path -LiteralPath $nodePath) -or !(Test-Path -LiteralPath $wrapperPath)) { throw 'DevEco toolchain not found' }
$env:DEVECO_SDK_HOME = Join-Path $DevEcoRoot 'sdk'
$env:NODE_HOME = Join-Path $DevEcoRoot 'tools\node'
$env:JAVA_HOME = Join-Path $DevEcoRoot 'jbr'
$env:PATH = "$env:JAVA_HOME\bin;$env:NODE_HOME;$env:PATH"
Push-Location $projectPath
try {
  & $nodePath $wrapperPath --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
} finally { Pop-Location }
