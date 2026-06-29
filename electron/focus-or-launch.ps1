param(
  [Parameter(Mandatory = $true)]
  [string]$LaunchPath,
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Focus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  public const int SW_RESTORE = 9;
}
"@

function Focus-ProcessWindow {
  param([System.Diagnostics.Process]$Process)

  if (-not $Process -or $Process.MainWindowHandle -eq [IntPtr]::Zero) {
    return $false
  }

  $hwnd = $Process.MainWindowHandle
  if ([Win32Focus]::IsIconic($hwnd)) {
    [void][Win32Focus]::ShowWindow($hwnd, [Win32Focus]::SW_RESTORE)
  }

  [void][Win32Focus]::SwitchToThisWindow($hwnd, $true)
  [void][Win32Focus]::SetForegroundWindow($hwnd)
  return $true
}

$processName = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)
$processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 })

if ($processes.Count -gt 0) {
  $target = $processes | Sort-Object {
    if ([string]::IsNullOrWhiteSpace($_.MainWindowTitle)) { 0 } else { 1 }
  }, LastInputTime -Descending | Select-Object -First 1

  if (Focus-ProcessWindow -Process $target) {
    Write-Output 'focused'
    exit 0
  }
}

Start-Process -FilePath $LaunchPath | Out-Null
Write-Output 'launched'
exit 0
