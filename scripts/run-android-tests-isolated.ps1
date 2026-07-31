param(
    [switch]$Full
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gradleRoot = Join-Path $env:USERPROFILE ".gradle"
$isolated = Join-Path $repo ".gradle-test"

function Assert-WorkspacePath([string] $path) {
    $resolved = [System.IO.Path]::GetFullPath($path)
    if (-not $resolved.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the repository: $resolved"
    }
}

Assert-WorkspacePath $isolated
if (Test-Path -LiteralPath $isolated) {
    $staleGradleHome = $env:GRADLE_USER_HOME
    $env:GRADLE_USER_HOME = $isolated
    Push-Location (Join-Path $repo "apps\android")
    try { & .\gradlew.bat --stop | Out-Null } finally { Pop-Location }
    $env:GRADLE_USER_HOME = $staleGradleHome
    Remove-Item -LiteralPath $isolated -Recurse -Force
}

try {
    New-Item -ItemType Directory -Path (Join-Path $isolated "caches\9.5.0") -Force | Out-Null
    foreach ($name in @("wrapper", "jdks")) {
        New-Item -ItemType Junction -Path (Join-Path $isolated $name) -Target (Join-Path $gradleRoot $name) | Out-Null
    }
    New-Item -ItemType Junction -Path (Join-Path $isolated "caches\modules-2") -Target (Join-Path $gradleRoot "caches\modules-2") | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath (Join-Path $gradleRoot "caches\9.5.0") -Force) {
        if ($item.PSIsContainer -and $item.Name -ne "workerMain") {
            New-Item -ItemType Junction -Path (Join-Path $isolated "caches\9.5.0\$($item.Name)") -Target $item.FullName | Out-Null
        }
    }

    $previousGradleHome = $env:GRADLE_USER_HOME
    $env:GRADLE_USER_HOME = $isolated
    try {
        Push-Location (Join-Path $repo "apps\android")
        try {
            $gradleTasks = @(":app:testDebugUnitTest")
            if ($Full) {
                $gradleTasks += @(
                    ":app:connectedDebugAndroidTest",
                    ":app:assembleRelease",
                    "-PwayMemoryApiUrl=https://way-memory.yxswy.com",
                    "--rerun-tasks"
                )
            }
            & .\gradlew.bat @gradleTasks --offline --no-daemon --no-parallel
            if ($LASTEXITCODE -ne 0) { throw "Android verification failed with exit code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
    } finally {
        $env:GRADLE_USER_HOME = $previousGradleHome
    }
} finally {
    Assert-WorkspacePath $isolated
    if (Test-Path -LiteralPath $isolated) {
        $env:GRADLE_USER_HOME = $isolated
        Push-Location (Join-Path $repo "apps\android")
        try { & .\gradlew.bat --stop | Out-Null } finally { Pop-Location }
        Remove-Item -LiteralPath $isolated -Recurse -Force
    }
}
