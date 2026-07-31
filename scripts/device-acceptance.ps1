param(
    [string]$ApkPath = "apps\android\app\build\outputs\apk\debug\app-debug.apk",
    [string]$Serial = ""
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedApk = (Resolve-Path (Join-Path $repo $ApkPath)).Path

$adbCommand = Get-Command adb -ErrorAction SilentlyContinue
if ($adbCommand) {
    $adb = $adbCommand.Source
} else {
    $sdkCandidate = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (-not (Test-Path -LiteralPath $sdkCandidate)) {
        throw "adb not found. Install Android SDK Platform-Tools or add adb to PATH."
    }
    $adb = $sdkCandidate
}

$deviceLines = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "^\S+\s+device$" })
if ($Serial) {
    if (-not ($deviceLines | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device$" })) {
        throw "Requested device is not connected or is not authorized: $Serial"
    }
} elseif ($deviceLines.Count -eq 1) {
    $Serial = ($deviceLines[0] -split "\s+")[0]
} elseif ($deviceLines.Count -eq 0) {
    throw "No authorized Android device found. Enable USB debugging and accept the RSA prompt."
} else {
    throw "Multiple Android devices found. Re-run with -Serial <device-serial>."
}

Write-Host "Device: $Serial"
Write-Host "APK: $resolvedApk"
Write-Host "APK SHA256: $((Get-FileHash -LiteralPath $resolvedApk -Algorithm SHA256).Hash)"

& $adb -s $Serial install -r $resolvedApk
if ($LASTEXITCODE -ne 0) { throw "APK installation failed with exit code $LASTEXITCODE" }

& $adb -s $Serial shell am force-stop com.puzzlefuzzy.waymemory
& $adb -s $Serial shell monkey -p com.puzzlefuzzy.waymemory 1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Unable to launch way-memory with exit code $LASTEXITCODE" }

Write-Host "Installed and launched successfully. Complete the manual capture matrix in docs/device-acceptance.md."
Write-Host "Public API: http://101.35.246.159/api/health"
Write-Host "Session list: http://101.35.246.159/api/sessions"
