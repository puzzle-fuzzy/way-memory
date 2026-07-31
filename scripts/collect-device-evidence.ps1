[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SessionId,
    [ValidateSet("baseline", "3d", "rotation", "loop", "stairs", "elevator")]
    [string]$Case = "baseline",
    [string]$ApiBase = "http://101.35.246.159",
    [ValidateRange(0, 1024)]
    [int]$MaxOutOfOrder = 0,
    [string]$OutputRoot = "artifacts"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sessionOutput = Join-Path (Join-Path $repo $OutputRoot) $SessionId
if (Test-Path -LiteralPath $sessionOutput) {
    throw "Evidence directory already exists: $sessionOutput. Choose a new OutputRoot or remove only this previous evidence directory after review."
}
New-Item -ItemType Directory -Path $sessionOutput -Force | Out-Null

$previousApiBase = $env:WAY_MEMORY_API_URL
$previousSessionId = $env:WAY_MEMORY_SESSION_ID
$env:WAY_MEMORY_API_URL = $ApiBase.TrimEnd("/")
$env:WAY_MEMORY_SESSION_ID = $SessionId

try {
    $reportPath = Join-Path $sessionOutput "$Case.json"
    & bun run acceptance:report "--session=$SessionId" "--case=$Case" "--max-out-of-order=$MaxOutOfOrder" "--out=$reportPath"
    if ($LASTEXITCODE -ne 0) {
        throw "Acceptance report failed for case '$Case' with exit code $LASTEXITCODE. The JSON report is kept for diagnosis: $reportPath"
    }

    $rawPath = Join-Path $sessionOutput "raw.json"
    Invoke-WebRequest -Uri "$($env:WAY_MEMORY_API_URL)/api/sessions/$([uri]::EscapeDataString($SessionId))/raw" -OutFile $rawPath -UseBasicParsing
    Write-Host "Evidence saved: $sessionOutput"
    Write-Host "Report: $reportPath"
    Write-Host "Raw replay: $rawPath"
}
finally {
    if ($null -eq $previousApiBase) { Remove-Item Env:WAY_MEMORY_API_URL -ErrorAction SilentlyContinue } else { $env:WAY_MEMORY_API_URL = $previousApiBase }
    if ($null -eq $previousSessionId) { Remove-Item Env:WAY_MEMORY_SESSION_ID -ErrorAction SilentlyContinue } else { $env:WAY_MEMORY_SESSION_ID = $previousSessionId }
}
