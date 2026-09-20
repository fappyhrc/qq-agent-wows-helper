# wows-helper bridge launcher (Windows / PowerShell)
#
# ASCII-ONLY ON PURPOSE. Windows PowerShell 5.1 reads .ps1 files as ANSI unless the
# file has a UTF-8 BOM, so any non-ASCII byte in here risks corrupting the parser
# (this bit us twice: once with Chinese comments, once with mangled legacy text).
# All Chinese documentation lives in ../README.md instead.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1
#   powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1 -Token "ACCOUNT_ID:TOKEN"
#   powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1 -SkipInstall
#   powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1 -ForceReinstall
#
# What it does:
#   1. locate a Python >= 3.11 (3.11/3.12 recommended; 3.13/3.14 verified working)
#   2. download Hikari-core-v2 source into .hikari-src and relax its requires-python cap
#   3. install dependencies into .hikari-deps via `pip --target`
#   4. ensure a chromium build is available (hikari-core downloads its own, so the
#      playwright copy is skipped when data/wows-yuyuko/browsers already exists)
#   5. start hikari_bridge.py in the foreground with PYTHONPATH pointing at .hikari-deps
#
# Notes:
#   * `pip --target` is used instead of a venv because some Windows Python builds ship
#     without ensurepip, where `python -m venv` fails outright.
#   * "already installed" is decided by actually importing hikari_core, NOT by a marker
#     file: deps installed by hand (or an interrupted run) would otherwise trigger a
#     full reinstall plus another 150MB chromium download on every launch.

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
  # Comma-separated FUNCTION names of features to disable, e.g.
  #   -IgnoreList "set_BindInfo,change_BindInfo,delete_BindInfo"
  # NOTE: must be function names (set_BindInfo), not command words (bind) --
  # upstream compares function objects, so a string list silently does nothing.
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
$hikariBrowsers = Join-Path $pluginDir 'data\wows-yuyuko\browsers'
$troubleshoot = "1) python versions: py -0 ; 2) deps dir: $depsDir ; 3) full reinstall: start-bridge.ps1 -ForceReinstall"

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn2([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

# Run a python snippet and report whether it succeeded, WITHOUT letting its stderr kill us.
#
# Why this helper exists: the script sets $ErrorActionPreference = 'Stop' (we want pip and
# playwright failures to abort). But with that preference, PowerShell 5.1 promotes a native
# command's *stderr output* to a terminating error -- and `import hikari_core` legitimately
# prints a WARNING to stderr. The result was a silent exit right after the Python probe:
# no bridge, no message. So every probe goes through here with the preference relaxed.
function Invoke-PythonProbe([string]$snippet) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $py @pyArgs -c $snippet 2>&1
    return @{ ok = ($LASTEXITCODE -eq 0); output = @($out) }
  } catch {
    return @{ ok = $false; output = @("$($_.Exception.Message)") }
  } finally {
    $ErrorActionPreference = $prev
  }
}

if (-not $Token) {
  # Not mandatory: the credential can also be supplied later from the QQ Agent plugin
  # settings (sent per request as hikari_token). Asking once here just saves a round trip.
  Write-Host ''
  Write-Host 'yuyuko API credential (format: accountID:Token)' -ForegroundColor Cyan
  Write-Host '  You may leave this EMPTY and fill it later in QQ Agent -> Plugins -> Warship Helper.' -ForegroundColor DarkGray
  try { $entered = Read-Host '  Paste it here (or press Enter to skip)' } catch { $entered = '' }
  if ($entered) { $Token = $entered.Trim() }
}
if (-not $Token) {
  Write-Warn2 'No credential given. The bridge still starts; fill it in the QQ Agent plugin settings.'
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
      if ($minor -gt 12) { Write-Host "    (upstream declares 3.11-3.12; $ver works because that cap is artificial)" }
      break
    }
  }
}
if (-not $py) {
  Write-Warn2 'No Python >= 3.11 found in PATH. Install Python 3.11/3.12 (3.13/3.14 also work) and retry.'
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
      $clone = Join-Path $srcDir '_clone'
      git clone --depth 1 https://github.com/wows-yuyuko/Hikari-core-v2 $clone
      Copy-Item (Join-Path $clone '*') $srcDir -Recurse -Force
      Remove-Item $clone -Recurse -Force -ErrorAction SilentlyContinue
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

  # Decide "already installed" by ACTUALLY IMPORTING hikari_core, not by a marker file.
  # A marker-only check means hand-installed deps (or an interrupted run) look missing,
  # so the script reinstalls and downloads chromium again -- which reads to the user as
  # "double-clicked and nothing happened for ages".
  $depsOk = $false
  if ((-not $ForceReinstall) -and (Test-Path (Join-Path $depsDir 'hikari_core'))) {
    $env:PYTHONPATH = $depsDir
    $probe = Invoke-PythonProbe "import hikari_core; print('hikari-core', hikari_core.__version__, 'import OK')"
    $depsOk = $probe.ok
    if ($depsOk) {
      Write-Host "    $($probe.output | Where-Object { $_ -match 'import OK' } | Select-Object -Last 1)"
      Write-Host '    (dependencies already usable - skipping install)'
      if (-not (Test-Path $readyMarker)) { New-Item -ItemType File -Path $readyMarker -Force | Out-Null }
    } else {
      Write-Warn2 "found .hikari-deps but the import failed, will reinstall. Last line: $($probe.output | Select-Object -Last 1)"
    }
  }

  if ($ForceReinstall -or -not $depsOk) {
    Write-Step "Installing Hikari-core-v2 into $depsDir"
    New-Item -ItemType Directory -Force -Path $depsDir | Out-Null
    & $py @pyArgs -m pip install --disable-pip-version-check --upgrade --target $depsDir $srcDir
    if ($LASTEXITCODE -ne 0) { Write-Warn2 'pip install failed'; exit 5 }
    New-Item -ItemType File -Path $readyMarker -Force | Out-Null
  } else {
    Write-Host "    dependencies already present ($depsDir)"
  }

  # chromium: hikari-core downloads its own build into <gamePath>/browsers and uses that
  # one, so the playwright copy is unnecessary when that directory already exists.
  if (Test-Path $hikariBrowsers) {
    Write-Host '    chromium already present (data\wows-yuyuko\browsers) - skipping download'
  } else {
    Write-Step 'Downloading playwright chromium (first run, ~150MB)'
    $env:PYTHONPATH = $depsDir
    & $py @pyArgs -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Warn2 'playwright install failed - rendering will not work until it succeeds' }
  }

  # Final pre-flight: state clearly whether the bridge will actually work, rather than
  # letting the user discover it by trying in a group chat.
  $env:PYTHONPATH = $depsDir
  $final = Invoke-PythonProbe 'import hikari_core'
  if (-not $final.ok) {
    Write-Warn2 'hikari-core is still not importable - the bridge will start with ready=false and every query will fail.'
    Write-Warn2 "Troubleshoot: $troubleshoot"
  }
}

Write-Step "Starting bridge on http://${BindHost}:${Port}"
Write-Host '    Set the QQ Agent plugin setting "bridgeUrl" to that address.'
Write-Host '    Press Ctrl+C to stop.'

$env:PYTHONPATH = $depsDir
# Make the bridge's Chinese log lines readable.
# Python writes UTF-8 bytes; a legacy Windows console decodes them as GBK/CP936, which
# turns every log line into mojibake. Changing [Console]::OutputEncoding is NOT enough
# (it only affects PowerShell's own writes) -- the console *codepage* has to change.
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
try {
  Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetConsoleOutputCP(uint id);'
  [void][W.K]::SetConsoleOutputCP(65001)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { Write-Warn2 'could not switch the console to UTF-8; log lines may look garbled' }

$bridgeArgs = @($bridgeScript, '--host', $BindHost, '--port', "$Port",
                '--image-type', $ImageType, '--use-browser', $UseBrowser)
if ($Token) { $bridgeArgs += @('--token', $Token) }
if ($AccessToken) { $bridgeArgs += @('--access-token', $AccessToken) }
if ($GamePath) { $bridgeArgs += @('--game-path', $GamePath) }
if ($Proxy) { $bridgeArgs += @('--proxy', $Proxy) }
if ($IgnoreList) { $bridgeArgs += @('--ignore-list', $IgnoreList) }

& $py @pyArgs @bridgeArgs
exit $LASTEXITCODE
