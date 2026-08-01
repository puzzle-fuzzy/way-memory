[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$ApiBaseUrl,
    [ValidateSet("debug", "release")]
    [string]$BuildType = "release",
    [string]$OutputRoot = "artifacts\android-release",
    [string]$JavaHome = ""
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $repo $OutputRoot))
if (-not $resolvedOutputRoot.StartsWith($repo + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must stay inside the repository: $resolvedOutputRoot"
}
if ($resolvedOutputRoot -eq $repo) {
    throw "Refusing to use the repository root as OutputRoot"
}

$apiUri = [Uri]$ApiBaseUrl.TrimEnd("/")
if ($apiUri.Scheme -ne "https") { throw "Release builds require an HTTPS API URL" }
$apiOrigin = $apiUri.GetLeftPart([UriPartial]::Authority)

if ($BuildType -eq "release") {
    $signingVariables = @(
        $env:WAY_MEMORY_RELEASE_KEYSTORE,
        $env:WAY_MEMORY_RELEASE_STORE_PASSWORD,
        $env:WAY_MEMORY_RELEASE_KEY_ALIAS,
        $env:WAY_MEMORY_RELEASE_KEY_PASSWORD
    )
    if ($signingVariables | Where-Object { -not $_ -or -not $_.ToString().Trim() }) {
        throw "Release APK signing requires WAY_MEMORY_RELEASE_KEYSTORE, WAY_MEMORY_RELEASE_STORE_PASSWORD, WAY_MEMORY_RELEASE_KEY_ALIAS, and WAY_MEMORY_RELEASE_KEY_PASSWORD; keep all values outside the repository. Use -BuildType debug for sensor-only field validation."
    }
    if (-not (Test-Path -LiteralPath $env:WAY_MEMORY_RELEASE_KEYSTORE)) {
        throw "Release keystore does not exist: $env:WAY_MEMORY_RELEASE_KEYSTORE"
    }
}

$selectedJavaHome = if ($JavaHome.Trim()) {
    $JavaHome.Trim()
} elseif ($env:JAVA_HOME) {
    $env:JAVA_HOME
} else {
    "D:\software\JetBeains\Programs\Android Studio\jbr"
}
if (-not (Test-Path -LiteralPath $selectedJavaHome)) {
    throw "JAVA_HOME does not exist: $selectedJavaHome"
}

$sourceCommit = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{7,64}$') {
    throw "Unable to resolve the current git commit"
}
$sourceCommitDate = (& git -C $repo show -s --format=%cI HEAD).Trim()
$artifactDirectory = Join-Path $resolvedOutputRoot "$sourceCommit-$BuildType"
if (Test-Path -LiteralPath $artifactDirectory) {
    throw "Refusing to overwrite an existing release artifact: $artifactDirectory"
}

$previousJavaHome = $env:JAVA_HOME
$env:JAVA_HOME = $selectedJavaHome
try {
    Push-Location (Join-Path $repo "apps\android")
    try {
        $gradleTask = ":app:assemble$($BuildType.Substring(0, 1).ToUpperInvariant())$($BuildType.Substring(1))"
        & .\gradlew.bat $gradleTask "-PwayMemoryApiUrl=$ApiBaseUrl" --offline --no-daemon --no-parallel
        if ($LASTEXITCODE -ne 0) { throw "Android release build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $previousJavaHome) {
        Remove-Item Env:JAVA_HOME -ErrorAction SilentlyContinue
    } else {
        $env:JAVA_HOME = $previousJavaHome
    }
}

$apkName = if ($BuildType -eq "release") { "app-release.apk" } else { "app-debug.apk" }
$apkPath = Join-Path $repo "apps\android\app\build\outputs\apk\$BuildType\$apkName"
if (-not (Test-Path -LiteralPath $apkPath)) {
    if ($BuildType -eq "release") {
        $unsignedPath = Join-Path $repo "apps\android\app\build\outputs\apk\release\app-release-unsigned.apk"
        if (Test-Path -LiteralPath $unsignedPath) { throw "Release APK is unsigned. Configure the external release signing variables; no installable artifact was created." }
    }
    throw "Android $BuildType APK was not produced: $apkPath"
}
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$artifactApkPath = Join-Path $artifactDirectory "way-memory-$BuildType.apk"
Copy-Item -LiteralPath $apkPath -Destination $artifactApkPath
$apkHash = (Get-FileHash -LiteralPath $artifactApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    format = "way-memory.android-release-manifest.v1"
    sourceCommit = $sourceCommit
    sourceCommitDate = $sourceCommitDate
    buildType = $BuildType
    apiBaseUrl = $apiOrigin
    apkPath = "way-memory-$BuildType.apk"
    apkSha256 = $apkHash
}
$manifestPath = Join-Path $artifactDirectory "ANDROID-RELEASE-MANIFEST.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host "Android release artifact: $artifactDirectory"
Write-Host "Source commit: $sourceCommit"
Write-Host "API origin: $apiOrigin"
Write-Host "APK SHA256: $apkHash"
