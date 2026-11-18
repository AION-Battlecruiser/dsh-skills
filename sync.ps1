<#
.SYNOPSIS
  로컬 DSH 스킬을 이 저장소로 복사하고 커밋·푸시한다.

.EXAMPLE
  .\sync.ps1
  .\sync.ps1 -Message "feat: add research skill"
  .\sync.ps1 -NoPush
#>
[CmdletBinding()]
param(
  [string]$Source = (Join-Path $HOME '.agents\skills'),
  [string]$Message = '',
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
Set-Location $repo

# git on drives without ownership records (e.g. E:\) needs an explicit exception
try {
  git rev-parse --is-inside-work-tree *> $null
} catch {
  git config --global --add safe.directory ((Resolve-Path $repo).Path -replace '\\', '/')
}

if (-not (Test-Path $Source)) { throw "skill source not found: $Source" }

# every top-level directory in this repo is one skill (SKILL.md inside)
$skills = Get-ChildItem $repo -Directory |
  Where-Object { $_.Name -notin @('.git', '.github', 'scripts') } |
  Select-Object -ExpandProperty Name

if ($skills.Count -eq 0) { throw "no skill directories in $repo" }

$copied = @()
foreach ($skillName in $skills) {
  $from = Join-Path $Source $skillName
  if (-not (Test-Path $from)) { Write-Warning "skip ${skillName}: not found in $Source"; continue }
  $to = Join-Path $repo $skillName
  New-Item -ItemType Directory -Path $to -Force | Out-Null
  Copy-Item -Path (Join-Path $from '*') -Destination $to -Recurse -Force
  $copied += $skillName
}

git add -A
if (-not (git status --porcelain)) {
  Write-Host "no changes to sync ($($copied -join ', '))"
  return
}

if ([string]::IsNullOrWhiteSpace($Message)) {
  $Message = "sync: $($copied -join ', ') @ $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
}

git -c core.autocrlf=false commit -m $Message | Out-Null
if ($NoPush) {
  Write-Host "committed (not pushed): $Message"
  return
}

git push | Out-Null
Write-Host "pushed: $Message"
Write-Host "repo: $(git remote get-url origin)"
