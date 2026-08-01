[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EvidenceRoot,
    [string]$ArtifactManifestPath = "",
    [string]$ExpectedApiBaseUrl = "",
    [string]$ExpectedSourceCommit = ""
)

$ErrorActionPreference = "Stop"
$requiredCases = @(
    "baseline",
    "3d",
    "rotation",
    "loop",
    "visual-recovery",
    "stairs",
    "elevator",
    "recovery",
    "network-interruption",
    "process-recovery"
)

function Get-Origin([string]$value) {
    if (-not $value -or -not $value.Trim()) { return $null }
    try { return ([Uri]$value).GetLeftPart([UriPartial]::Authority).TrimEnd('/') } catch { return $null }
}

function Resolve-ManifestFile([string]$baseDirectory, [string]$relativePath, [string]$label) {
    if (-not $relativePath -or [System.IO.Path]::IsPathRooted($relativePath)) {
        throw "$label must be a relative file name"
    }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $baseDirectory $relativePath))
    $base = ([System.IO.Path]::GetFullPath($baseDirectory)).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$label escapes its evidence directory"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$label does not exist: $candidate"
    }
    return $candidate
}

$rootCandidate = if ([System.IO.Path]::IsPathRooted($EvidenceRoot)) { $EvidenceRoot } else { Join-Path (Get-Location) $EvidenceRoot }
$resolvedRoot = (Resolve-Path -LiteralPath $rootCandidate).Path
$artifact = $null
if ($ArtifactManifestPath.Trim()) {
    $artifactCandidate = if ([System.IO.Path]::IsPathRooted($ArtifactManifestPath)) { $ArtifactManifestPath } else { Join-Path (Get-Location) $ArtifactManifestPath }
    $resolvedArtifactManifest = (Resolve-Path -LiteralPath $artifactCandidate).Path
    $artifact = Get-Content -Raw -LiteralPath $resolvedArtifactManifest | ConvertFrom-Json
    if ($artifact.format -ne "way-memory.android-release-manifest.v1") {
        throw "ArtifactManifestPath is not an Android release manifest: $resolvedArtifactManifest"
    }
}

$expectedOrigin = Get-Origin $ExpectedApiBaseUrl
$expectedCommit = $ExpectedSourceCommit.Trim()
$matrixErrors = [System.Collections.Generic.List[string]]::new()
$validByCase = @{}
$manifestFiles = @(Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File -Filter "EVIDENCE-MANIFEST.json")

foreach ($manifestFile in $manifestFiles) {
    try {
        $evidence = Get-Content -Raw -LiteralPath $manifestFile.FullName | ConvertFrom-Json
        if ($evidence.format -ne "way-memory.device-evidence-manifest.v1") {
            $matrixErrors.Add("$($manifestFile.FullName): unsupported evidence format")
            continue
        }
        $caseName = [string]$evidence.acceptanceCase
        if ($requiredCases -notcontains $caseName) {
            $matrixErrors.Add("$($manifestFile.FullName): unsupported or unexpected case '$caseName'")
            continue
        }
        $evidenceDirectory = $manifestFile.DirectoryName
        $reportPath = Resolve-ManifestFile $evidenceDirectory ([string]$evidence.reportPath) "reportPath"
        $rawPath = Resolve-ManifestFile $evidenceDirectory ([string]$evidence.rawReplayPath) "rawReplayPath"
        $reportHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $rawHash = (Get-FileHash -LiteralPath $rawPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($reportHash -ne ([string]$evidence.reportSha256).ToLowerInvariant()) { throw "report SHA-256 mismatch" }
        if ($rawHash -ne ([string]$evidence.rawReplaySha256).ToLowerInvariant()) { throw "raw replay SHA-256 mismatch" }

        $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
        $raw = Get-Content -Raw -LiteralPath $rawPath | ConvertFrom-Json
        if ($report.casePassed -ne $true) { throw "acceptance report casePassed is not true" }
        if ([string]$report.acceptanceCase -ne $caseName) { throw "acceptance report case does not match evidence manifest" }
        if ([string]$report.sessionId -ne [string]$evidence.sessionId) { throw "acceptance report session does not match evidence manifest" }
        if (-not ($raw.samples -is [array])) { throw "raw replay does not contain a samples array" }
        if (-not (Get-Origin ([string]$evidence.apiBaseUrl))) { throw "evidence apiBaseUrl is not a valid origin" }
        if ($expectedOrigin -and (Get-Origin ([string]$evidence.apiBaseUrl)) -ne $expectedOrigin) { throw "API origin mismatch: $caseName" }
        if ($expectedCommit -and [string]$evidence.sourceCommit -ne $expectedCommit) { throw "source commit mismatch: $caseName" }

        if ($artifact) {
            if (-not $evidence.artifact) { throw "Android artifact provenance is missing" }
            if ([string]$evidence.artifact.sourceCommit -ne [string]$artifact.sourceCommit) { throw "artifact source commit mismatch" }
            if ((Get-Origin ([string]$evidence.artifact.apiBaseUrl)) -ne (Get-Origin ([string]$artifact.apiBaseUrl))) { throw "artifact API origin mismatch" }
            if ([string]$evidence.artifact.apkSha256 -ne [string]$artifact.apkSha256) { throw "artifact APK SHA-256 mismatch" }
        }
        if ($validByCase.ContainsKey($caseName)) { throw "duplicate valid evidence for case '$caseName'" }
        $validByCase[$caseName] = [ordered]@{
            case = $caseName
            sessionId = [string]$evidence.sessionId
            evidenceDirectory = $evidenceDirectory
            sourceCommit = [string]$evidence.sourceCommit
            apiBaseUrl = [string]$evidence.apiBaseUrl
            rawSamples = @($raw.samples).Count
        }
    } catch {
        $matrixErrors.Add("$($manifestFile.FullName): $($_.Exception.Message)")
    }
}

$missingCases = @($requiredCases | Where-Object { -not $validByCase.ContainsKey($_) })
if ($missingCases.Count -gt 0) {
    $matrixErrors.Add("missing required cases: $($missingCases -join ', ')")
}

$result = [ordered]@{
    format = "way-memory.device-matrix-check.v1"
    evidenceRoot = $resolvedRoot
    requiredCases = $requiredCases
    verifiedCases = @($validByCase.Values)
    missingCases = $missingCases
    errors = @($matrixErrors)
    artifactSourceCommit = if ($artifact) { [string]$artifact.sourceCommit } else { $null }
    expectedApiBaseUrl = $expectedOrigin
    expectedSourceCommit = if ($expectedCommit) { $expectedCommit } else { $null }
    passed = $matrixErrors.Count -eq 0
}

$result | ConvertTo-Json -Depth 8
if (-not $result.passed) { exit 1 }
