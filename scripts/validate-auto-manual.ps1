# MANUAL ONLY - DO NOT RUN IN CI
#
# Validates `baton pass --auto` against the real OpenCode CLI.
# Creates a temp git repo, runs the full init -> claim -> pass --auto pipeline,
# verifies the handoff output, then cleans up.
#
# PREREQUISITES:
#   1. OpenCode CLI installed and on PATH (`opencode --version` works)
#   2. Valid OpenCode subscription (the headless invocation consumes requests)
#   3. Git configured with user.name and user.email
#   4. Node.js >= 20
#   5. This script must be run from the baton project root or anywhere on the
#      same machine — it resolves the baton source via $BatonRoot
#
# USAGE:
#   .\scripts\validate-auto-manual.ps1
#   .\scripts\validate-auto-manual.ps1 -Agent claude-code   # test a different agent
#   .\scripts\validate-auto-manual.ps1 -AutoTimeout 180     # longer timeout

param(
    [string]$Agent = "opencode",
    [int]$AutoTimeout = 120
)

$ErrorActionPreference = "Stop"

# --- Resolve baton project root ---
$BatonRoot = $env:BATON_ROOT
if (-not $BatonRoot) {
    $BatonRoot = Split-Path -Parent $PSScriptRoot
}
$BatonCmd = "npx"
$BatonArgs = @("tsx", "$BatonRoot\src\index.ts")

# --- Prerequisite checks ---
Write-Host "=== Baton --auto Manual Validation ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "Checking prerequisites..." -ForegroundColor Yellow

# Check Node.js
try {
    $nodeVersion = & node --version 2>&1
    Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  FAIL: Node.js not found on PATH" -ForegroundColor Red
    exit 1
}

# Check git
try {
    $gitVersion = & git --version 2>&1
    Write-Host "  Git: $gitVersion" -ForegroundColor Green
} catch {
    Write-Host "  FAIL: git not found on PATH" -ForegroundColor Red
    exit 1
}

# Check git user configured
$gitUser = & git config --global user.name 2>&1
$gitEmail = & git config --global user.email 2>&1
if (-not $gitUser -or $gitUser -match "^$") {
    Write-Host "  FAIL: git user.name not configured. Run: git config --global user.name 'Your Name'" -ForegroundColor Red
    exit 1
}
if (-not $gitEmail -or $gitEmail -match "^$") {
    Write-Host "  FAIL: git user.email not configured. Run: git config --global user.email 'you@example.com'" -ForegroundColor Red
    exit 1
}
Write-Host "  Git identity: $gitUser <$gitEmail>" -ForegroundColor Green

# Check agent CLI on PATH
try {
    $null = Get-Command $Agent -ErrorAction Stop
    Write-Host "  Agent CLI ($Agent): found" -ForegroundColor Green
} catch {
    Write-Host "  FAIL: '$Agent' not found on PATH. Install it or pass -Agent <name>" -ForegroundColor Red
    exit 1
}

# Check baton source exists
$batonSrc = Join-Path $BatonRoot "src\index.ts"
if (-not (Test-Path $batonSrc)) {
    Write-Host "  FAIL: baton source not found at $batonSrc" -ForegroundColor Red
    Write-Host "  Set `$env:BATON_ROOT to the baton project directory" -ForegroundColor Red
    exit 1
}
Write-Host "  Baton source: $BatonRoot" -ForegroundColor Green

Write-Host ""
Write-Host "All prerequisites met." -ForegroundColor Green
Write-Host ""

# --- Helper: run baton command ---
function Invoke-Baton {
    param([string[]]$Args, [string]$WorkingDir)
    $allArgs = $BatonArgs + $Args
    Write-Host "  > baton $($Args -join ' ')" -ForegroundColor DarkGray
    $prevDir = Get-Location
    try {
        Set-Location $WorkingDir
        & $BatonCmd @allArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
        $exitCode = $LASTEXITCODE
    } finally {
        Set-Location $prevDir
    }
    return $exitCode
}

# --- Create temp repo ---
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempDir = Join-Path $env:TEMP "baton-validate-$timestamp"
$passed = $false

try {
    Write-Host "Creating temp repo: $tempDir" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    # Initialize git repo
    & git init $tempDir 2>&1 | Out-Null
    & git -C $tempDir config user.name $gitUser
    & git -C $tempDir config user.email $gitEmail

    # Create initial commit (baton needs at least one commit for headCommit)
    Set-Content -Path (Join-Path $tempDir "README.md") -Value "# Validation Test`nTemp repo for baton --auto validation."
    & git -C $tempDir add README.md
    & git -C $tempDir commit -m "initial commit" 2>&1 | Out-Null

    Write-Host ""

    # --- Step 1: baton init ---
    Write-Host "Step 1: baton init --agent $Agent --test-cmd 'echo ok' --auto" -ForegroundColor Cyan
    $exitCode = Invoke-Baton -Args @("init", "--agent", $Agent, "--test-cmd", "echo ok", "--auto") -WorkingDir $tempDir
    if ($exitCode -ne 0) {
        Write-Host "FAIL: baton init exited with code $exitCode" -ForegroundColor Red
        exit 1
    }

    # Verify .baton/ was created
    $batonDir = Join-Path $tempDir ".baton"
    if (-not (Test-Path $batonDir)) {
        Write-Host "FAIL: .baton/ directory not created" -ForegroundColor Red
        exit 1
    }
    Write-Host "  .baton/ created successfully" -ForegroundColor Green
    Write-Host ""

    # --- Step 2: baton claim ---
    Write-Host "Step 2: baton claim" -ForegroundColor Cyan
    $exitCode = Invoke-Baton -Args @("claim") -WorkingDir $tempDir
    if ($exitCode -ne 0) {
        Write-Host "FAIL: baton claim exited with code $exitCode" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Claim successful" -ForegroundColor Green
    Write-Host ""

    # --- Step 3: baton pass --auto ---
    Write-Host "Step 3: baton pass --auto --auto-timeout $AutoTimeout" -ForegroundColor Cyan
    Write-Host "  (This invokes $Agent headlessly — may take up to ${AutoTimeout}s)" -ForegroundColor DarkGray
    $exitCode = Invoke-Baton -Args @("pass", "--auto", "--auto-timeout", "$AutoTimeout") -WorkingDir $tempDir
    if ($exitCode -ne 0) {
        Write-Host "FAIL: baton pass --auto exited with code $exitCode" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Pass completed successfully" -ForegroundColor Green
    Write-Host ""

    # --- Step 4: Verify HANDOFF.md ---
    Write-Host "Step 4: Verifying HANDOFF.md" -ForegroundColor Cyan
    $handoffPath = Join-Path $tempDir ".baton\HANDOFF.md"
    if (-not (Test-Path $handoffPath)) {
        Write-Host "FAIL: .baton/HANDOFF.md not found after pass" -ForegroundColor Red
        exit 1
    }

    $handoffContent = Get-Content $handoffPath -Raw

    # Check header
    if ($handoffContent -notmatch "^# Handoff — ") {
        Write-Host "FAIL: HANDOFF.md missing '# Handoff — ...' header" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Header: present" -ForegroundColor Green

    # Check required sections (must match REQUIRED_SECTIONS in src/core/handoff.ts)
    $requiredSections = @(
        "Where things stand",
        "Done this session",
        "In progress / next up",
        "Blockers & landmines",
        "Branch & build state"
    )

    $allSectionsOk = $true
    foreach ($section in $requiredSections) {
        $heading = "## $section"
        if ($handoffContent -notmatch [regex]::Escape($heading)) {
            Write-Host "  FAIL: Missing section '$heading'" -ForegroundColor Red
            $allSectionsOk = $false
            continue
        }

        # Extract section body and check for unfilled placeholders
        $pattern = "(?s)" + [regex]::Escape($heading) + "\s*\n(.*?)(?=\n## |\z)"
        if ($handoffContent -match $pattern) {
            $body = $Matches[1]
            if ($body -match "_\(fill me in\)_") {
                Write-Host "  FAIL: Section '$heading' still has placeholder" -ForegroundColor Red
                $allSectionsOk = $false
            } elseif ($body.Trim().Length -eq 0) {
                Write-Host "  FAIL: Section '$heading' is empty" -ForegroundColor Red
                $allSectionsOk = $false
            } else {
                Write-Host "  Section '$section': filled" -ForegroundColor Green
            }
        } else {
            Write-Host "  WARN: Could not extract body of '$heading'" -ForegroundColor Yellow
        }
    }

    if (-not $allSectionsOk) {
        Write-Host ""
        Write-Host "HANDOFF.md content:" -ForegroundColor Yellow
        Write-Host $handoffContent
        exit 1
    }

    # --- Step 5: Verify state ---
    Write-Host ""
    Write-Host "Step 5: Verifying state after pass" -ForegroundColor Cyan

    # Check tag was created
    $tagOutput = & git -C $tempDir tag -l "baton/pass/*" 2>&1
    if ($tagOutput -match "baton/pass/1") {
        Write-Host "  Tag baton/pass/1: present" -ForegroundColor Green
    } else {
        Write-Host "  WARN: Tag baton/pass/1 not found (tags: $tagOutput)" -ForegroundColor Yellow
    }

    # Check sessions archive exists
    $sessionsDir = Join-Path $tempDir ".baton\sessions"
    if (Test-Path $sessionsDir) {
        $archiveCount = (Get-ChildItem $sessionsDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
        Write-Host "  Sessions archive: $archiveCount file(s)" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "=== ALL CHECKS PASSED ===" -ForegroundColor Green
    $passed = $true

} finally {
    # --- Cleanup ---
    Write-Host ""
    if (Test-Path $tempDir) {
        Write-Host "Cleaning up temp directory: $tempDir" -ForegroundColor Yellow
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $tempDir) {
            Write-Host "  WARN: Could not fully remove temp directory" -ForegroundColor Yellow
        } else {
            Write-Host "  Cleaned up" -ForegroundColor Green
        }
    }
}

if (-not $passed) {
    exit 1
}
