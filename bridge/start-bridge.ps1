# wows-helper bridge launcher (Windows / PowerShell)
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless the file
# has a BOM, so non-ASCII comments here would turn into mojibake. All Chinese docs
# live in ../README.md instead.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1 -Token "ACCOUNT_ID:TOKEN"
#   powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1 -Token "..." -Port 8788 -AccessToken "mypass"
#
# What it does:
#   1. finds a Python >= 3.11 (3.11 / 3.12 recommended; 3.13 / 3.14 verified working)
#   2. downloads Hikari-core-v2 source into .hikari-src and relaxes its requires-python
#      cap (the upstream pyproject says >=3.11,<3.13, which is stricter than reality)
#   3. installs it into .hikari-deps (--target) together with playwright chromium
#   4. starts hikari_bridge.py in the foreground with PYTHONPATH pointing at .hikari-deps
#
# Note: we install with --target instead of a venv because some Windows Python builds
# ship without ensurepip, where `python -m venv` fails.

[CmdletBinding()]
param(
  [string]$Token = $env:HIKARI_TOKEN,
  [int]$Port = 8788,
  [string]$BindHost = '127.0.0.1',
  [string]$AccessToken = $env:WOWS_HELPER_ACCESS_TOKEN,
  [string]$GamePath = $env:WOWS_HELPER_GAME_PATH,
  [string]$Proxy = $env:WOWS_HELPER_PROXY,
  [string]$ImageType = 'jpeg',
  [string]$UseBrowser = 'chromium',
  # 禁用的功能函数名（逗号分隔）。写操作/更新类指令想关掉就填，例：
  #   -IgnoreList "set_BindInfo,change_BindInfo,delete_BindInfo"
  # 注意传**函数名**（set_BindInfo），不是指令词（bind）—— 上游比的是函数对象。
  [string]$IgnoreList = $env:WOWS_HELPER_IGNORE_LIST,
  [switch]$SkipInstall,
  [switch]$ForceReinstall
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginDir = Split-Path -Parent $scriptDir
$srcDir = Join-Path $pluginDir '.hikari-src'
$depsDir = Join-Path $pluginDir '.hikari-deps'
$bridgeScript = Join-Path $scriptDir 'hikari_bridge.py'
$tarball = Join-Path $pluginDir '.hikari-src.tar.gz'
$readyMarker = Join-Path $depsDir '.ready'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn2([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

if (-not $Token) {
  # 不强制：凭据也可以之后在 QQ Agent 的插件设置页里填（请求里带 hikari_token）。
  # 这里问一次只是因为"顺手填了"能少一次来回；直接回车就跳过。
  Write-Host ''
  Write-Host 'yuyuko API credential (format  accountID:Token)' -ForegroundColor Cyan
  Write-Host '  You can leave this EMPTY and fill it later in QQ Agent -> Plugins -> Warship Helper -> yuyuko API credential.' -ForegroundColor DarkGray
  try { $entered = Read-Host '  Paste it here (or press Enter to skip)' } catch { $entered = '' }
  if ($entered) { $Token = $entered.Trim() }
}

if (-not $Token) {
  Write-Warn2 'No credential given. The bridge will still start; fill the credential in the QQ Agent plugin settings.'
  Write-Warn2 'Alternatively restart with -Token "accountID:Token" or set the HIKARI_TOKEN environment variable.'
}

Write-Step 'Locating python'
$py = $null
$pyArgs = @()
foreach ($candidate in @('py -3.12', 'py -3.11', 'py -3.13', 'py -3.14', 'py -3', 'python', 'python3')) {
  $parts = $candidate.Split(' ')
  $exe = $parts[0]
  $rest = @()
  if ($parts.Length -gt 1) { $rest = $parts[1..($parts.Length - 1)] }
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
  try { $ver = & $exe @rest -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null } catch { continue }
  if ($LASTEXITCODE -eq 0 -and $ver) {
    $major = [int]($ver.Split('.')[0]); $minor = [int]($ver.Split('.')[1])
    if ($major -eq 3 -and $minor -ge 11) {
      $py = $exe; $pyArgs = $rest
      Write-Host "    found $candidate -> python $ver"
      if ($minor -gt 12) { Write-Host "    (upstream declares 3.11-3.12; $ver works because the cap is artificial)" }
      break
    }
  }
}
if (-not $py) {
  Write-Warn2 'No Python >= 3.11 found in PATH. Install Python 3.11/3.12 (or 3.13/3.14) and retry.'
  exit 3
}

function Ensure-Source {
  if (Test-Path (Join-Path $srcDir 'pyproject.toml')) { return }
  Write-Step 'Downloading Hikari-core-v2 source'
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  $url = 'https://codeload.github.com/wows-yuyuko/Hikari-core-v2/tar.gz/refs/heads/main'
  try {
    Invoke-WebRequest -Uri $url -OutFile $tarball -UseBasicParsing
  } catch {
    Write-Warn2 "download failed: $($_.Exception.Message)"
    if (Get-Command git -ErrorAction SilentlyContinue) {
      Write-Step 'Trying git clone instead'
      git clone --depth 1 https://github.com/wows-yuyuko/Hikari-core-v2 (Join-Path $srcDir '_clone')
      $inner = Join-Path $srcDir '_clone'
      Copy-Item (Join-Path $inner '*') $srcDir -Recurse -Force
      Remove-Item $inner -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Write-Warn2 'Neither download nor git available - aborting'
      exit 4
    }
  }
  if (Test-Path $tarball) {
    tar -xzf $tarball -C $srcDir
    $inner = Get-ChildItem $srcDir -Directory | Where-Object { $_.Name -like 'Hikari-core-v2-*' } | Select-Object -First 1
    if ($inner) {
      Copy-Item (Join-Path $inner.FullName '*') $srcDir -Recurse -Force
      Remove-Item $inner.FullName -Recurse -Force
    }
    Remove-Item $tarball -Force -ErrorAction SilentlyContinue
  }
  # relax the artificial version cap so pip accepts 3.13/3.14
  $toml = Join-Path $srcDir 'pyproject.toml'
  $text = [System.IO.File]::ReadAllText($toml)
  $patched = $text -replace 'requires-python\s*=\s*">=3\.11,<3\.13"', 'requires-python = ">=3.11"'
  if ($patched -ne $text) {
    [System.IO.File]::WriteAllText($toml, $patched, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '    relaxed requires-python to >=3.11'
  }
}

if (-not $SkipInstall -or $ForceReinstall) {
  Ensure-Source
  if ($ForceReinstall -or -not (Test-Path $readyMarker)) {
    Write-Step "Installing Hikari-core-v2 into $depsDir"
    New-Item -ItemType Directory -Force -Path $depsDir | Out-Null
    & $py @pyArgs -m pip install --disable-pip-version-check --upgrade --target $depsDir $srcDir
    if ($LASTEXITCODE -ne 0) { Write-Warn2 'pip install failed'; exit 5 }
    Write-Step 'Downloading playwright chromium (first run, ~150MB)'
    $env:PYTHONPATH = $depsDir
    & $py @pyArgs -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Warn2 'playwright install failed - rendering will not work' }
    New-Item -ItemType File -Path $readyMarker -Force | Out-Null
  } else {
    Write-Host "    dependencies already present ($depsDir)"
  }
}

Write-Step "Starting bridge on http://${BindHost}:${Port}"
Write-Host "    Point the QQ Agent plugin setting 'bridgeUrl' at that address."
Write-Host '    Press Ctrl+C to stop.'

$env:PYTHONPATH = $depsDir
$env:PYTHONIOENCODING = 'utf-8'
$bridgeArgs = @($bridgeScript, '--host', $BindHost, '--port', "$Port",
                '--image-type', $ImageType, '--use-browser', $UseBrowser)
if ($Token) { $bridgeArgs += @('--token', $Token) }
if ($AccessToken) { $bridgeArgs += @('--access-token', $AccessToken) }
if ($GamePath) { $bridgeArgs += @('--game-path', $GamePath) }
if ($Proxy) { $bridgeArgs += @('--proxy', $Proxy) }
if ($IgnoreList) { $bridgeArgs += @('--ignore-list', $IgnoreList) }

& $py @pyArgs @bridgeArgs
exit $LASTEXITCODE
