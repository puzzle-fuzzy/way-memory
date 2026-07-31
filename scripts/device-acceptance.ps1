param(
    [string]$ApkPath = "apps\android\app\build\outputs\apk\debug\app-debug.apk",
    [string]$Serial = "",
    [switch]$RequirePhysical,
    [string]$ApiBaseUrl = ""
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedApk = (Resolve-Path (Join-Path $repo $ApkPath)).Path
$displayApiBaseUrl = if ($ApiBaseUrl.Trim()) {
    $ApiBaseUrl.TrimEnd('/')
} elseif ($env:WAY_MEMORY_API_URL) {
    $env:WAY_MEMORY_API_URL.TrimEnd('/')
} else {
    "http://101.35.246.159"
}
if ($RequirePhysical -and -not $displayApiBaseUrl.StartsWith("https://", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Physical sensor acceptance requires an HTTPS API endpoint; refusing to send real route data to the anonymous HTTP test deployment: $displayApiBaseUrl"
}

$adbCommand = Get-Command adb -ErrorAction SilentlyContinue
if ($adbCommand) {
    $adb = $adbCommand.Source
} else {
    $sdkCandidates = @()
    if ($env:ANDROID_SDK_ROOT) { $sdkCandidates += (Join-Path $env:ANDROID_SDK_ROOT "platform-tools\adb.exe") }
    if ($env:ANDROID_HOME) { $sdkCandidates += (Join-Path $env:ANDROID_HOME "platform-tools\adb.exe") }
    if ($env:LOCALAPPDATA) { $sdkCandidates += (Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe") }
    $sdkCandidates += "D:\software\Android-Sdk\platform-tools\adb.exe"
    $sdkCandidate = $sdkCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $sdkCandidate) {
        throw "adb not found. Install Android SDK Platform-Tools or add adb to PATH."
    }
    $adb = $sdkCandidate
}

$deviceLines = @(& $adb devices -l | Select-Object -Skip 1 | Where-Object { $_ -match "^\S+\s+device\b" })
if ($Serial) {
    if (-not ($deviceLines | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device\b" })) {
        throw "Requested device is not connected or is not authorized: $Serial"
    }
} elseif ($deviceLines.Count -eq 1) {
    $Serial = ($deviceLines[0] -split "\s+")[0]
} elseif ($deviceLines.Count -eq 0) {
    throw "No authorized Android device found. Enable USB debugging and accept the RSA prompt."
} else {
    throw "Multiple Android devices found. Re-run with -Serial <device-serial>."
}

$selectedLine = $deviceLines | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device\b" } | Select-Object -First 1
$emulatorFlag = (& $adb -s $Serial shell getprop ro.kernel.qemu 2>$null).Trim()
$isEmulator = $Serial.StartsWith("emulator-", [System.StringComparison]::OrdinalIgnoreCase) -or $emulatorFlag -eq "1"
if ($RequirePhysical -and $isEmulator) {
    throw "A physical Android phone is required for sensor acceptance; selected device is an emulator: $Serial"
}

Write-Host "Device: $Serial"
Write-Host "Device kind: $(if ($isEmulator) { 'emulator (protocol/lifecycle only)' } else { 'physical Android device' })"
if ($selectedLine) { Write-Host "ADB descriptor: $selectedLine" }
Write-Host "APK: $resolvedApk"
Write-Host "APK SHA256: $((Get-FileHash -LiteralPath $resolvedApk -Algorithm SHA256).Hash)"

& $adb -s $Serial install -r $resolvedApk
if ($LASTEXITCODE -ne 0) { throw "APK installation failed with exit code $LASTEXITCODE" }

& $adb -s $Serial shell am force-stop com.puzzlefuzzy.waymemory
& $adb -s $Serial shell monkey -p com.puzzlefuzzy.waymemory 1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Unable to launch way-memory with exit code $LASTEXITCODE" }

Write-Host "Installed and launched successfully. Complete the manual capture matrix in docs/device-acceptance.md."
Write-Host "Configured API: $displayApiBaseUrl"
Write-Host "Health probe: $displayApiBaseUrl/api/health"
Write-Host "Session evidence: $displayApiBaseUrl/api/sessions/<SESSION_ID>"
