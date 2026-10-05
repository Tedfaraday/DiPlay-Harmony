param([string]$DeviceId='', [string]$SdkRoot=$env:DIPLAY_SDK_ROOT)
$ErrorActionPreference='Stop'
if (!$SdkRoot) { throw 'Set DIPLAY_SDK_ROOT or pass -SdkRoot' }
$taskHdc=Join-Path $SdkRoot 'toolchains\hdc.exe'
$taskArguments=@()
if($DeviceId){$taskArguments+=@('-t',$DeviceId)}
# Read only the application's dedicated, payload-free protocol diagnostic tag.
$taskArguments+=@('shell','hilog','-x','-t','app','-T','DiPlaySession,DiPlayVideo,DiPlayAudio')
& $taskHdc @taskArguments
if($LASTEXITCODE -ne 0){throw 'Unable to read session diagnostics'}
