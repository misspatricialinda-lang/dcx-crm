param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v\d+\.\d+\.\d+$')]
    [string]$Version,
    [string]$Note = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$archiveRoot = Join-Path $projectRoot 'workflow-versions'
$snapshotPath = Join-Path $archiveRoot $Version

if (Test-Path -LiteralPath $snapshotPath) {
    throw "Snapshot $Version already exists. Choose a new version; existing snapshots are never overwritten."
}

$workflowFiles = @(
    'workflow 1.json',
    'workflow 2 - draft actions.json',
    'workflow 3 - send reply.json'
)

# Validate every source before creating the snapshot directory.
foreach ($filename in $workflowFiles) {
    $sourcePath = Join-Path $projectRoot $filename
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "Missing workflow file: $filename"
    }
    $null = Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json
}

$null = New-Item -ItemType Directory -Path $snapshotPath -Force
$entries = foreach ($filename in $workflowFiles) {
    $sourcePath = Join-Path $projectRoot $filename
    $destinationPath = Join-Path $snapshotPath $filename
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
    [ordered]@{
        file = $filename
        sha256 = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$manifest = [ordered]@{
    version = $Version
    created_at = (Get-Date).ToUniversalTime().ToString('o')
    note = $Note
    deployment_status = 'local snapshot only; n8n import and publish must be verified separately'
    files = @($entries)
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $snapshotPath 'manifest.json') -Encoding utf8
Write-Output "Created $snapshotPath"
