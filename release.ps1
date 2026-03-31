# release.ps1
param(
    [string]$Version
)

if (-not $Version) {
    $current = (Get-Content package.json | ConvertFrom-Json).version
    Write-Host "Current version: $current"
    $Version = Read-Host "Enter new version (e.g. 0.1.12)"
}

if (-not $Version) {
    Write-Error "Version is required"
    exit 1
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Invalid version format, expected x.y.z"
    exit 1
}

Write-Host "Releasing v$Version ..." -ForegroundColor Cyan

npm version $Version --no-git-tag-version
if ($LASTEXITCODE -ne 0) { Write-Error "npm version failed"; exit 1 }

npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; exit 1 }

npm run typecheck
if ($LASTEXITCODE -ne 0) { Write-Error "Type check failed"; exit 1 }

git add package.json
git commit -m "chore: release v$Version"
if ($LASTEXITCODE -ne 0) { Write-Error "git commit failed"; exit 1 }

git tag "v$Version"
if ($LASTEXITCODE -ne 0) { Write-Error "git tag failed"; exit 1 }

npm publish
if ($LASTEXITCODE -ne 0) { Write-Error "npm publish failed"; exit 1 }

git push --follow-tags
if ($LASTEXITCODE -ne 0) { Write-Error "git push failed"; exit 1 }

Write-Host "Released v$Version" -ForegroundColor Green
