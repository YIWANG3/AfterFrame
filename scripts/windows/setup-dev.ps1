# One-time setup for a Windows 10/11 machine used to develop and test
# AfterFrame (a cloud VM reached over SSH from a dev Mac, or a local PC).
#
# Run in PowerShell *as Administrator*, either from a checkout:
#   .\scripts\windows\setup-dev.ps1 -GitHubKeysUser <you>
# or straight from GitHub on a fresh machine:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/YIWANG3/AfterFrame/<commit>/scripts/windows/setup-dev.ps1))) -GitHubKeysUser <you>
#
# What it does, each step safe to re-run:
#   1. Installs Git, Node.js 22, Python 3.12 and uv with winget.
#   2. Enables long paths; git with LF line endings and long paths.
#   3. Turns on the OpenSSH server with PowerShell as its shell, key-only
#      logins, and the public keys GitHub publishes for -GitHubKeysUser.
#   4. Limits inbound SSH and Remote Desktop to -AllowFrom (by default the
#      address of the Remote Desktop session running this script), so a
#      machine with a public IP isn't open to the whole internet. If that
#      address changes later, use the provider's web console to update it.
#   5. Clones the repository.
param(
  # GitHub account whose published SSH keys (https://github.com/<user>.keys)
  # may log in. Without it SSH is still installed, but no key is authorized.
  [string]$GitHubKeysUser = "",
  # Address (or comma-separated list / CIDR) allowed to reach SSH and RDP.
  [string]$AllowFrom = "",
  # Leave SSH and RDP open to any address (not recommended on a public IP).
  [switch]$NoIpRestriction,
  [string]$RepoUrl = "https://github.com/YIWANG3/AfterFrame.git",
  [string]$RepoDir = "C:\dev\AfterFrame"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in PowerShell opened with 'Run as administrator'."
}

# ---- 1. toolchain ------------------------------------------------------------
Step "Toolchain (winget)"
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  # Fresh Windows 11 images sometimes have App Installer present but not yet
  # registered for this user.
  Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction SilentlyContinue
}
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is not available. Install 'App Installer' from the Microsoft Store, then run this again."
}

$packages = @("Git.Git", "OpenJS.NodeJS.22", "Python.Python.3.12", "astral-sh.uv")
foreach ($id in $packages) {
  winget list --id $id --exact --source winget --accept-source-agreements *> $null
  if ($LASTEXITCODE -eq 0) { Write-Host "$id already installed"; continue }
  Write-Host "installing $id"
  winget install --id $id --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "winget install $id failed (exit $LASTEXITCODE)" }
}
# Pick up the PATH entries the installers just added.
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

# ---- 2. paths and git --------------------------------------------------------
Step "Long paths and git settings"
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -Type DWord
git config --global core.longpaths true
# The repo has no .gitattributes; keep files as committed (LF) so fixtures and
# scripts match what macOS and Linux CI see.
git config --global core.autocrlf false
# Remote work happens over SSH; keep the machine from sleeping under us.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

# ---- 3. OpenSSH server -------------------------------------------------------
Step "OpenSSH server"
$capability = Get-WindowsCapability -Online -Name "OpenSSH.Server*" | Select-Object -First 1
if ($capability.State -ne "Installed") { Add-WindowsCapability -Online -Name $capability.Name | Out-Null }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd   # first start writes C:\ProgramData\ssh\sshd_config

New-Item -Path "HKLM:\SOFTWARE\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null

$sshdConfig = "$env:ProgramData\ssh\sshd_config"
$config = Get-Content $sshdConfig -Raw
$config = $config -replace '(?m)^#?\s*PasswordAuthentication\s+\S+', 'PasswordAuthentication no'
$config = $config -replace '(?m)^#?\s*PubkeyAuthentication\s+\S+', 'PubkeyAuthentication yes'
if ($config -notmatch '(?m)^PasswordAuthentication no') { $config = "PasswordAuthentication no`r`n" + $config }
Set-Content -Path $sshdConfig -Value $config -Encoding ascii

if ($GitHubKeysUser) {
  # Administrators' keys live in one shared file that only Administrators and
  # SYSTEM may read; sshd ignores it otherwise. SIDs, not names: group names
  # are localized (a Chinese Windows has no "Administrators" group by that name).
  $keys = (Invoke-RestMethod "https://github.com/$GitHubKeysUser.keys").Trim()
  if (-not $keys) { throw "github.com/$GitHubKeysUser.keys has no public keys." }
  $authorized = "$env:ProgramData\ssh\administrators_authorized_keys"
  Set-Content -Path $authorized -Value $keys -Encoding ascii
  icacls $authorized /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F" | Out-Null
  Write-Host "authorized $(($keys -split "`n").Count) key(s) from github.com/$GitHubKeysUser"
} else {
  Write-Warning "No -GitHubKeysUser: SSH has no authorized keys and password login is off, so nobody can log in over SSH yet."
}
Restart-Service sshd

if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
# On Windows 10/11 the rule the capability creates covers only the Private
# profile, and a cloud VM's network is Public: without this SSH stays blocked.
Set-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -Profile Any -Enabled True

# ---- 4. who may connect ------------------------------------------------------
Step "Restrict SSH and Remote Desktop"
if (-not $NoIpRestriction) {
  if (-not $AllowFrom) {
    $AllowFrom = (Get-NetTCPConnection -LocalPort 3389 -State Established -ErrorAction SilentlyContinue |
      Where-Object { $_.RemoteAddress -notmatch '^(127\.|::1|0\.0\.0\.0)' } |
      Select-Object -ExpandProperty RemoteAddress -Unique | Select-Object -First 1)
  }
  if (-not $AllowFrom) {
    throw "Couldn't tell which address you are connecting from. Pass -AllowFrom <your public IP>, or -NoIpRestriction."
  }
  $allowed = $AllowFrom -split '\s*,\s*'
  Set-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -RemoteAddress $allowed
  # Every inbound allow rule for the RDP port, found by port rather than by
  # the "Remote Desktop" group: cloud images often add a rule of their own.
  Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq "3389" } |
    Get-NetFirewallRule | Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" } |
    Set-NetFirewallRule -RemoteAddress $allowed
  Write-Host "SSH and Remote Desktop now accept connections only from: $($allowed -join ', ')"
} else {
  Write-Warning "SSH and Remote Desktop stay open to any address."
}

# ---- 5. repository -----------------------------------------------------------
Step "Repository"
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
  New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null
  git clone $RepoUrl $RepoDir
} else {
  Write-Host "$RepoDir already cloned"
}

# ---- summary -----------------------------------------------------------------
Step "Done"
$publicIp = try { (Invoke-RestMethod "https://api.ipify.org" -TimeoutSec 10).Trim() } catch { "(unknown)" }
# A tool an installer put on PATH only for new sessions shouldn't fail the run.
function Version($command, [string[]]$arguments) {
  try { (& $command @arguments 2>&1 | Select-Object -First 1) } catch { "(not on PATH in this window; open a new one)" }
}
Write-Host "user:     $($identity.Name.Split('\')[-1])"
Write-Host "address:  $publicIp"
Write-Host "repo:     $RepoDir"
Write-Host "git:      $(Version git '--version')"
Write-Host "node:     $(Version node '--version')"
Write-Host "python:   $(Version py '-3.12', '--version')"
Write-Host "uv:       $(Version uv '--version')"
Write-Host "`nFrom the Mac:  ssh $($identity.Name.Split('\')[-1])@$publicIp"
