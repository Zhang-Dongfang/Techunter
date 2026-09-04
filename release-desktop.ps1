param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error 'Invalid version format, expected x.y.z'
    exit 1
}

if (git status --porcelain) {
    Write-Error 'The working tree must be clean before creating a Desktop release.'
    exit 1
}

$current = node -p "require('./apps/desktop/package.json').version"
if ([version]$Version -le [version]$current) {
    Write-Error "Version must be newer than the current Desktop version $current."
    exit 1
}

Write-Host "Preparing Techunter Desktop v$Version ..." -ForegroundColor Cyan

npm version $Version --workspace @techunter/desktop --no-git-tag-version
if ($LASTEXITCODE -ne 0) { Write-Error 'Version update failed'; exit 1 }

npm run build --workspace @techunter/core
if ($LASTEXITCODE -ne 0) { Write-Error 'Core build failed'; exit 1 }

npm run test --workspace @techunter/desktop
if ($LASTEXITCODE -ne 0) { Write-Error 'Desktop tests failed'; exit 1 }

npm run build --workspace @techunter/desktop
if ($LASTEXITCODE -ne 0) { Write-Error 'Desktop build failed'; exit 1 }

git add -- apps/desktop/package.json package-lock.json
git commit -m "chore(desktop): release v$Version"
if ($LASTEXITCODE -ne 0) { Write-Error 'Release commit failed'; exit 1 }

git tag -a "desktop-v$Version" -m "Techunter Desktop v$Version"
if ($LASTEXITCODE -ne 0) { Write-Error 'Release tag failed'; exit 1 }

git push --atomic origin HEAD "refs/tags/desktop-v$Version"
if ($LASTEXITCODE -ne 0) { Write-Error 'Push failed'; exit 1 }

Write-Host "Desktop v$Version was pushed. GitHub Actions will publish the installer and update metadata." -ForegroundColor Green
