import { clipboard } from "electron";
import { spawn } from "node:child_process";
import type { OutputMode } from "./config";

export interface DesktopWindowOption {
  id: string;
  title: string;
  process: string;
}

export function writeToClipboard(text: string): void {
  clipboard.writeText(text);
}

export async function handleOutput(
  text: string,
  mode: OutputMode,
  targetWindowId?: string | null,
): Promise<void> {
  writeToClipboard(text);
  if (targetWindowId) {
    const focused = await focusWindow(targetWindowId);
    if (!focused) {
      throw new Error(
        `Could not focus target window (${targetWindowId}). Bring it to the foreground once and try again.`,
      );
    }
    await sleep(140);
    await simulateCtrlV();
    return;
  }
  if (mode === "auto-paste") {
    await simulateCtrlV();
  }
}

export function listDesktopWindows(): Promise<DesktopWindowOption[]> {
  return new Promise((resolve) => {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue';",
      "$items = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.ProcessName -ne 'PromptFlux' } | Sort-Object MainWindowTitle | Select-Object @{Name='id';Expression={[string]$_.MainWindowHandle}}, @{Name='title';Expression={$_.MainWindowTitle}}, @{Name='process';Expression={$_.ProcessName}});",
      "$items | ConvertTo-Json -Compress",
    ].join(" ");
    const child = spawn("powershell", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("exit", () => {
      try {
        const parsed = JSON.parse(stdout);
        const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        const normalized = list
          .map((item) => ({
            id: String(item?.id ?? ""),
            title: String(item?.title ?? ""),
            process: String(item?.process ?? ""),
          }))
          .filter((item) => item.id && item.title);
        resolve(normalized);
      } catch {
        resolve([]);
      }
    });
    child.on("error", () => resolve([]));
  });
}

export function focusWindow(windowId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue';",
      "$idArg = $args[0];",
      "$h = 0;",
      "if (-not [Int64]::TryParse($idArg, [ref]$h)) { exit 1 }",
      "Add-Type @\"",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class PromptFluxWinApi {",
      '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);',
      '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);',
      "}",
      "\"@;",
      "$ptr = [IntPtr]::new($h);",
      "if (-not [PromptFluxWinApi]::IsWindow($ptr)) { exit 2 }",
      "[PromptFluxWinApi]::ShowWindowAsync($ptr, 9) | Out-Null;",
      "Start-Sleep -Milliseconds 120;",
      "$current = [PromptFluxWinApi]::GetForegroundWindow();",
      "$currentPid = 0;",
      "$targetPid = 0;",
      "$currentThread = [PromptFluxWinApi]::GetWindowThreadProcessId($current, [ref]$currentPid);",
      "$targetThread = [PromptFluxWinApi]::GetWindowThreadProcessId($ptr, [ref]$targetPid);",
      "$attached = $false;",
      "if ($currentThread -ne 0 -and $targetThread -ne 0 -and $currentThread -ne $targetThread) {",
      "  $attached = [PromptFluxWinApi]::AttachThreadInput($currentThread, $targetThread, $true);",
      "}",
      "[PromptFluxWinApi]::BringWindowToTop($ptr) | Out-Null;",
      "$ok = [PromptFluxWinApi]::SetForegroundWindow($ptr);",
      "Start-Sleep -Milliseconds 120;",
      "if ($attached) {",
      "  [PromptFluxWinApi]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null;",
      "}",
      "if (-not $ok -and $targetPid -gt 0) {",
      "  try {",
      "    Add-Type -AssemblyName Microsoft.VisualBasic;",
      "    [Microsoft.VisualBasic.Interaction]::AppActivate($targetPid) | Out-Null;",
      "    $ok = $true;",
      "  } catch {",
      "    $ok = $false;",
      "  }",
      "}",
      "if ($ok) { exit 0 }",
      "exit 3",
    ].join(" ");

    const child = spawn("powershell", ["-NoProfile", "-Command", script, windowId], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function simulateCtrlV(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
      ],
      { windowsHide: true },
    );
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
