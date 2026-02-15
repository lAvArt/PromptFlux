import { ChildProcess, spawn } from "node:child_process";

const POLL_INTERVAL_MS = 20;

type HotkeyHandlers = {
  onStart: () => void;
  onStop: () => void;
  onError?: (message: string) => void;
};

function normalizeToken(token: string): string {
  return token.trim().toUpperCase().replace(/\s+/g, "");
}

function tokenToVirtualKey(token: string): number {
  const t = normalizeToken(token);

  if (t.length === 1 && t >= "A" && t <= "Z") {
    return t.charCodeAt(0);
  }
  if (t.length === 1 && t >= "0" && t <= "9") {
    return t.charCodeAt(0);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(t)) {
    const n = Number.parseInt(t.slice(1), 10);
    return 0x70 + (n - 1);
  }

  switch (t) {
    case "CTRL":
    case "CONTROL":
    case "CMDORCTRL":
      return 0x11;
    case "SHIFT":
      return 0x10;
    case "ALT":
    case "OPTION":
      return 0x12;
    case "SPACE":
    case "SPACEBAR":
      return 0x20;
    case "WIN":
    case "META":
    case "SUPER":
    case "COMMAND":
      return 0x5b;
    case "ENTER":
    case "RETURN":
      return 0x0d;
    case "TAB":
      return 0x09;
    case "ESC":
    case "ESCAPE":
      return 0x1b;
    default:
      throw new Error(`Unsupported hotkey token: ${token}`);
  }
}

function parseHotkey(hotkey: string): number[] {
  const tokens = hotkey.split("+").map((part) => part.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Hotkey cannot be empty");
  }

  const mapped = tokens.map(tokenToVirtualKey);
  return Array.from(new Set(mapped));
}

function watcherScript(keys: number[]): string {
  const keyList = keys.join(",");
  return `
Add-Type @"
using System.Runtime.InteropServices;
public static class PromptFluxNative {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@;
$keys = @(${keyList});
$down = $false;
while ($true) {
  $allDown = $true;
  foreach ($k in $keys) {
    if (([PromptFluxNative]::GetAsyncKeyState($k) -band 0x8000) -eq 0) {
      $allDown = $false;
      break;
    }
  }
  if ($allDown -and -not $down) {
    $down = $true;
    Write-Output "DOWN";
  } elseif (-not $allDown -and $down) {
    $down = $false;
    Write-Output "UP";
  }
  Start-Sleep -Milliseconds ${POLL_INTERVAL_MS};
}
`.trim();
}

export class HotkeyController {
  private active = false;
  private watcher: ChildProcess | null = null;
  private stdoutBuffer = "";
  private watcherStopping = false;

  registerHoldToTalkHotkey(hotkey: string, handlers: HotkeyHandlers): void {
    this.unregisterAll();
    this.watcherStopping = false;
    const keyCodes = parseHotkey(hotkey);
    const ps = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", watcherScript(keyCodes)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    this.watcher = ps;
    ps.stdout?.setEncoding("utf8");

    ps.stdout?.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split(/\r?\n/);
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = line.trim();
        if (event === "DOWN" && !this.active) {
          this.active = true;
          handlers.onStart();
        } else if (event === "UP" && this.active) {
          this.active = false;
          handlers.onStop();
        }
      }
    });

    ps.on("exit", (code) => {
      this.watcher = null;
      if (!this.watcherStopping && code !== 0 && code !== null) {
        handlers.onError?.(`Hotkey watcher exited with code ${code ?? -1}`);
      }
    });
  }

  resetState(): void {
    this.active = false;
  }

  unregisterAll(): void {
    this.watcherStopping = true;
    this.active = false;
    if (this.watcher && !this.watcher.killed) {
      this.watcher.kill();
    }
    this.watcher = null;
    this.stdoutBuffer = "";
  }
}
