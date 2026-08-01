param(
    [string]$ApkPath = "apps\android\app\build\outputs\apk\debug\app-debug.apk",
    [string]$Serial = "",
    [switch]$RequirePhysical,
    [switch]$RequireRelease,
    [Alias("ReleaseManifestPath")]
    [string]$ArtifactManifestPath = "",
    [string]$ApiBaseUrl = ""
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
function Resolve-InputPath([string]$path, [string]$label) {
    if (-not $path -or -not $path.Trim()) {
        throw "$label must not be empty"
    }
    $candidate = if ([System.IO.Path]::IsPathRooted($path)) {
        $path
    } else {
        Join-Path $repo $path
    }
    return (Resolve-Path -LiteralPath $candidate).Path
}

$resolvedApk = Resolve-InputPath $ApkPath "ApkPath"
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

if ($RequireRelease) {
    if (-not $ArtifactManifestPath.Trim()) {
        throw "-RequireRelease needs -ArtifactManifestPath from build-android-release.ps1"
    }
}
if ($RequirePhysical -and -not $ArtifactManifestPath.Trim()) {
    throw "-RequirePhysical needs -ArtifactManifestPath so the field APK origin and checksum are verified before installation"
}
if ($ArtifactManifestPath.Trim()) {
    $resolvedManifest = Resolve-InputPath $ArtifactManifestPath "ArtifactManifestPath"
    $releaseManifest = Get-Content -Raw -LiteralPath $resolvedManifest | ConvertFrom-Json
    if ($releaseManifest.format -ne "way-memory.android-release-manifest.v1") {
        throw "The Android manifest is not a way-memory release artifact: $resolvedManifest"
    }
    if ($RequireRelease -and $releaseManifest.buildType -ne "release") {
        throw "-RequireRelease needs a release artifact manifest: $resolvedManifest"
    }
    $manifestOrigin = ([Uri]$releaseManifest.apiBaseUrl).GetLeftPart([UriPartial]::Authority)
    $expectedOrigin = ([Uri]$displayApiBaseUrl).GetLeftPart([UriPartial]::Authority)
    if ($manifestOrigin -ne $expectedOrigin) {
        throw "APK API origin does not match the acceptance endpoint: $manifestOrigin vs $expectedOrigin"
    }
    $manifestApk = Join-Path (Split-Path -Parent $resolvedManifest) $releaseManifest.apkPath
    if ((Resolve-Path $manifestApk).Path -ne $resolvedApk) {
        throw "APK path does not match the artifact manifest"
    }
    $manifestHash = (Get-FileHash -LiteralPath $resolvedApk -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($manifestHash -ne ([string]$releaseManifest.apkSha256).ToLowerInvariant()) {
        throw "APK SHA256 does not match the artifact manifest"
    }
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
