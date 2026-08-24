# Installer lifecycle: install -> verify -> reinstall over top (repair) -> uninstall.
#
# The app installs PER-MACHINE (Program Files, HKLM, All Users shortcuts), so
# this script must run elevated. It re-launches itself with RunAs if needed.
#
# An earlier version of this test only ever exercised the per-user path and
# reported everything green, while the real install went machine-wide and was
# never covered. Paths here follow the shipping configuration.

$ErrorActionPreference = 'Continue'

$elevated = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $elevated) {
    Write-Host "per-machine install requires elevation - relaunching..."
    $p = Start-Process powershell -Verb RunAs -PassThru -Wait -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"", "-Transcript"
    )
    exit $p.ExitCode
}

$log = "$env:TEMP\lcl-installer-test.log"
Start-Transcript -Path $log -Force | Out-Null

$setup  = "C:\.lcl\dist\lcl-Setup-1.0.0.exe"
$dir    = "$env:ProgramFiles\.lcl"
$data   = "$env:APPDATA\.lcl"
$desk   = "$env:PUBLIC\Desktop\.lcl.lnk"
$startm = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\.lcl.lnk"
$un     = "$dir\Uninstall .lcl.exe"

$pass = 0; $fail = 0
function Check($name, $cond, $detail = "") {
    if ($cond) { $script:pass++; Write-Host "PASS | $name" }
    else { $script:fail++; Write-Host "FAIL | $name$(if($detail){" - $detail"})" }
}
function RegEntry {
    Get-ChildItem 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -EA SilentlyContinue |
      ForEach-Object { Get-ItemProperty $_.PSPath -EA SilentlyContinue } |
      Where-Object { $_.DisplayName -like '*lcl*' }
}
function Stop-Lcl {
    Get-Process ".lcl","electron","llama-server" -EA SilentlyContinue |
        Stop-Process -Force -Confirm:$false
    Start-Sleep 4
}

Write-Host "=== 0. clean slate ==="
Stop-Lcl
if (Test-Path $un) { Start-Process $un -ArgumentList "/S","/allusers" -Wait; Start-Sleep 12 }
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -EA SilentlyContinue }
Check "starting with nothing installed" (-not (Test-Path $dir)) "install dir still present"

Write-Host "`n=== 1. INSTALL (per-machine) ==="
$p = Start-Process $setup -ArgumentList "/S" -PassThru -Wait
Start-Sleep 10
Stop-Lcl

Check "installer exited 0" ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
Check "installed to Program Files" (Test-Path "$dir\.lcl.exe") $dir
Check "engine binary present" (Test-Path "$dir\resources\engine\runtimes\llama.cpp\win-x64\llama-server.exe")
Check "model bundled" (Test-Path "$dir\resources\engine\models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf")
Check "policy kernel present" (Test-Path "$dir\resources\engine\orchestrator\policy\kernel.js")
Check "All Users Start Menu shortcut" (Test-Path $startm)
Check "All Users Desktop shortcut" (Test-Path $desk)
Check "registered in HKLM Add/Remove" ((RegEntry | Measure-Object).Count -eq 1)
Check "uninstaller present" (Test-Path $un)

$sizeGB = [math]::Round(((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum)/1GB,2)
Write-Host "       installed size: $sizeGB GB"

$sh = New-Object -ComObject WScript.Shell
Check "shortcut targets the installed exe" ($sh.CreateShortcut($startm).TargetPath -eq "$dir\.lcl.exe") `
      $sh.CreateShortcut($startm).TargetPath

# the fixes that must actually be in the shipped bundle
$asar = [System.Text.Encoding]::UTF8.GetString(
    [System.IO.File]::ReadAllBytes("$dir\resources\app.asar"))
Check "bundle sets AppUserModelId (single taskbar icon)" ($asar -match 'setAppUserModelId')
Check "bundle has landing hidden at boot" ($asar -match '<div id="landing" class="hidden"')
Check "bundle suppresses the intro on launch" ($asar -match 'landingDismissed\.add\(sessions\[0\]\.id\)')
Check "bundle uses object-fit contain" ($asar -match 'object-fit: contain')

Write-Host "`n=== 2. REPAIR (reinstall over the top) ==="
$model = "$dir\resources\engine\models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
Remove-Item $model -Force
Check "simulated damage: model removed" (-not (Test-Path $model))

$p2 = Start-Process $setup -ArgumentList "/S" -PassThru -Wait
Start-Sleep 10
Stop-Lcl
Check "repair run exited 0" ($p2.ExitCode -eq 0) "exit $($p2.ExitCode)"
Check "repair restored the missing model" (Test-Path $model)
Check "app still launchable after repair" (Test-Path "$dir\.lcl.exe")
Check "still one Add/Remove entry, not two" ((RegEntry | Measure-Object).Count -eq 1)
Check "user data survived the repair" (Test-Path "$data\data\sessions")

Write-Host "`n=== 3. UNINSTALL ==="
Stop-Lcl
$p3 = Start-Process $un -ArgumentList "/S","/allusers" -PassThru -Wait
Start-Sleep 14

Check "uninstaller exited 0" ($p3.ExitCode -eq 0) "exit $($p3.ExitCode)"
Check "install directory gone" (-not (Test-Path $dir)) "still at $dir"
Check "Start Menu shortcut removed" (-not (Test-Path $startm))
Check "Desktop shortcut removed" (-not (Test-Path $desk))
Check "Add/Remove entry removed" ((RegEntry | Measure-Object).Count -eq 0)
Check "user data preserved (silent uninstall keeps it by design)" (Test-Path $data)

Write-Host "`n$pass/$($pass+$fail) installer checks passed"
Stop-Transcript | Out-Null
if ($fail) { exit 1 }
