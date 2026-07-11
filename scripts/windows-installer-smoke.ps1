$ErrorActionPreference = 'Stop'

$installer = Get-ChildItem release -File -Filter '*.exe' |
  Where-Object Name -NotMatch 'Uninstall' |
  Select-Object -First 1
if (-not $installer) { throw 'NSIS installer not found' }

$installDir = Join-Path $env:RUNNER_TEMP "OneDrive - Studio\Director's Cut\场景 Installed App"
$installArgument = "/D=`"$installDir`""
$install = Start-Process $installer.FullName -ArgumentList @('/S', $installArgument) -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer exited $($install.ExitCode)" }

$appExe = Get-ChildItem $installDir -File -Filter '*.exe' |
  Where-Object Name -NotMatch 'Uninstall' |
  Select-Object -First 1
if (-not $appExe) { throw 'Installed application executable missing' }

$startMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcut = Get-ChildItem $startMenuRoot -Recurse -Filter 'Stem Studio*.lnk' | Select-Object -First 1
if (-not $shortcut) { throw 'Start Menu shortcut missing' }
$desktopRoot = [Environment]::GetFolderPath('Desktop')
$desktopShortcut = Get-ChildItem $desktopRoot -Filter 'Stem Studio*.lnk' | Select-Object -First 1
if (-not $desktopShortcut) { throw 'Desktop shortcut missing' }

$oldPath = $env:PATH
try {
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  $smoke = Start-Process $appExe.FullName -ArgumentList '--smoke-runtime' -Wait -PassThru
  if ($smoke.ExitCode -ne 0) { throw "Installed runtime smoke exited $($smoke.ExitCode)" }
} finally {
  $env:PATH = $oldPath
}

$normal = Start-Process $appExe.FullName -PassThru
Start-Sleep -Seconds 5
Stop-Process -Id $normal.Id -Force -ErrorAction SilentlyContinue

$descriptorPath = Join-Path $installDir 'resources\stem-studio-distribution.json'
if (-not (Test-Path $descriptorPath)) { throw 'Packaged distribution descriptor missing' }
$descriptor = Get-Content $descriptorPath -Raw | ConvertFrom-Json
$dataRoot = Join-Path $env:APPDATA $descriptor.userDataFolder
if (-not (Test-Path $dataRoot)) { throw "Expected per-user data root was not created: $dataRoot" }

$uninstaller = Get-ChildItem $installDir -Filter 'Uninstall*.exe' | Select-Object -First 1
if (-not $uninstaller) { throw 'Uninstaller missing' }
$uninstall = Start-Process $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited $($uninstall.ExitCode)" }
if (Test-Path $appExe.FullName) { throw 'Installed executable remains after uninstall' }
if (Test-Path $shortcut.FullName) { throw 'Start Menu shortcut remains after uninstall' }
if (Test-Path $desktopShortcut.FullName) { throw 'Desktop shortcut remains after uninstall' }
if (-not (Test-Path $dataRoot)) { throw 'Uninstall unexpectedly removed user data' }

$remaining = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) }
  catch { $false }
}
if ($remaining) { throw "Application process remains after uninstall: $($remaining.Name -join ', ')" }

Write-Host "Installer lifecycle passed; data retained at $dataRoot"
