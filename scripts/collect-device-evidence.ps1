[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')]
    [string]$SessionId,
    [ValidateSet("baseline", "3d", "rotation", "loop", "stairs", "elevator", "recovery", "visual-recovery")]
    [string]$Case = "baseline",
    [string]$ApiBase = "http://101.35.246.159",
    [ValidateRange(0, 1024)]
    [int]$MaxOutOfOrder = 0,
    [ValidateRange(0.1, 100)]
    [double]$MaxRecoveryJumpM = 1.5,
    [ValidateRange(0.1, 100)]
    [double]$MaxVisualResetJumpM = 5,
    [string]$OutputRoot = "artifacts",
    [string]$ArtifactManifestPath = "",
    [switch]$RequireArtifact
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRootCandidate = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
    $OutputRoot
} else {
    Join-Path $repo $OutputRoot
}
$resolvedOutputRoot = [System.IO.Path]::GetFullPath($outputRootCandidate)
if (-not $resolvedOutputRoot.StartsWith($repo + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must stay inside the repository: $resolvedOutputRoot"
}
if ($resolvedOutputRoot -eq $repo) {
    throw "Refusing to use the repository root as OutputRoot"
}
$sessionOutput = Join-Path $resolvedOutputRoot $SessionId
if (Test-Path -LiteralPath $sessionOutput) {
    throw "Evidence directory already exists: $sessionOutput. Choose a new OutputRoot or remove only this previous evidence directory after review."
}

if ($RequireArtifact -and -not $ArtifactManifestPath.Trim()) {
    throw "-RequireArtifact needs -ArtifactManifestPath from build-android-release.ps1"
}

$resolvedArtifactManifest = $null
$artifact = $null
if ($ArtifactManifestPath.Trim()) {
    $artifactCandidate = if ([System.IO.Path]::IsPathRooted($ArtifactManifestPath)) {
        $ArtifactManifestPath
    } else {
        Join-Path $repo $ArtifactManifestPath
    }
    $resolvedArtifactManifest = (Resolve-Path -LiteralPath $artifactCandidate).Path
    $artifact = Get-Content -Raw -LiteralPath $resolvedArtifactManifest | ConvertFrom-Json
    if ($artifact.format -ne "way-memory.android-release-manifest.v1") {
        throw "The Android manifest is not a way-memory release artifact: $resolvedArtifactManifest"
    }
}

$previousApiBase = $env:WAY_MEMORY_API_URL
$previousSessionId = $env:WAY_MEMORY_SESSION_ID
$env:WAY_MEMORY_API_URL = $ApiBase.TrimEnd("/")
$env:WAY_MEMORY_SESSION_ID = $SessionId
$dashboardToken = $env:WAY_MEMORY_DASHBOARD_TOKEN
$apiUri = [uri]$env:WAY_MEMORY_API_URL
if ($dashboardToken -and $apiUri.Scheme -ne "https" -and $apiUri.Host -notin @("127.0.0.1", "localhost")) {
    throw "WAY_MEMORY_DASHBOARD_TOKEN requires an HTTPS ApiBase outside localhost. The token was not sent."
}
$expectedApiOrigin = $apiUri.GetLeftPart([UriPartial]::Authority)
if ($artifact) {
    $artifactApiOrigin = ([Uri]$artifact.apiBaseUrl).GetLeftPart([UriPartial]::Authority)
    if ($artifactApiOrigin -ne $expectedApiOrigin) {
        throw "APK API origin does not match the evidence endpoint: $artifactApiOrigin vs $expectedApiOrigin"
    }
    if (-not $artifact.sourceCommit -or -not $artifact.buildType -or -not $artifact.apkSha256) {
        throw "Android artifact manifest is missing sourceCommit, buildType, or apkSha256"
    }
    $artifactApkPath = Join-Path (Split-Path -Parent $resolvedArtifactManifest) $artifact.apkPath
    if (-not (Test-Path -LiteralPath $artifactApkPath)) {
        throw "APK referenced by the artifact manifest does not exist: $artifactApkPath"
    }
    $artifactApkHash = (Get-FileHash -LiteralPath $artifactApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($artifactApkHash -ne ([string]$artifact.apkSha256).ToLowerInvariant()) {
        throw "APK SHA256 does not match the artifact manifest"
    }
}
New-Item -ItemType Directory -Path $sessionOutput -Force | Out-Null
$requestHeaders = @{}
if ($dashboardToken) { $requestHeaders["Authorization"] = "Bearer $dashboardToken" }

try {
    $reportPath = Join-Path $sessionOutput "$Case.json"
    & bun run acceptance:report "--session=$SessionId" "--case=$Case" "--max-out-of-order=$MaxOutOfOrder" "--max-recovery-jump-m=$MaxRecoveryJumpM" "--max-visual-reset-jump-m=$MaxVisualResetJumpM" "--out=$reportPath"
    if ($LASTEXITCODE -ne 0) {
        throw "Acceptance report failed for case '$Case' with exit code $LASTEXITCODE. The JSON report is kept for diagnosis: $reportPath"
    }

    $rawPath = Join-Path $sessionOutput "raw.json"
    Invoke-WebRequest -Uri "$($env:WAY_MEMORY_API_URL)/api/sessions/$([uri]::EscapeDataString($SessionId))/raw" -Headers $requestHeaders -OutFile $rawPath -UseBasicParsing
    $sourceCommit = (& git -C $repo rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{7,64}$') {
        throw "Unable to resolve the current git commit for evidence provenance"
    }
    $reportHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $rawHash = (Get-FileHash -LiteralPath $rawPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $evidenceManifest = [ordered]@{
        format = "way-memory.device-evidence-manifest.v1"
        generatedAt = [DateTime]::UtcNow.ToString("o")
        sourceCommit = $sourceCommit
        apiBaseUrl = $expectedApiOrigin
        sessionId = $SessionId
        acceptanceCase = $Case
        reportPath = [System.IO.Path]::GetFileName($reportPath)
        reportSha256 = $reportHash
        rawReplayPath = [System.IO.Path]::GetFileName($rawPath)
        rawReplaySha256 = $rawHash
    }
    if ($artifact) {
        $evidenceManifest.artifact = [ordered]@{
            manifestPath = [System.IO.Path]::GetFileName($resolvedArtifactManifest)
            sourceCommit = [string]$artifact.sourceCommit
            sourceCommitDate = [string]$artifact.sourceCommitDate
            buildType = [string]$artifact.buildType
            apiBaseUrl = ([Uri]$artifact.apiBaseUrl).GetLeftPart([UriPartial]::Authority)
            apkPath = [System.IO.Path]::GetFileName([string]$artifact.apkPath)
            apkSha256 = ([string]$artifact.apkSha256).ToLowerInvariant()
        }
    }
    $evidenceManifestPath = Join-Path $sessionOutput "EVIDENCE-MANIFEST.json"
    $evidenceManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidenceManifestPath -Encoding UTF8
    Write-Host "Evidence saved: $sessionOutput"
    Write-Host "Report: $reportPath"
    Write-Host "Raw replay: $rawPath"
    Write-Host "Evidence manifest: $evidenceManifestPath"
}
finally {
    if ($null -eq $previousApiBase) { Remove-Item Env:WAY_MEMORY_API_URL -ErrorAction SilentlyContinue } else { $env:WAY_MEMORY_API_URL = $previousApiBase }
    if ($null -eq $previousSessionId) { Remove-Item Env:WAY_MEMORY_SESSION_ID -ErrorAction SilentlyContinue } else { $env:WAY_MEMORY_SESSION_ID = $previousSessionId }
}
