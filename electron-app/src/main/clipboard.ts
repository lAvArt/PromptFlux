import { clipboard } from "electron";
import { spawn } from "node:child_process";
import type { OutputMode } from "./config";

export function writeToClipboard(text: string): void {
  clipboard.writeText(text);
}

export async function handleOutput(text: string, mode: OutputMode): Promise<void> {
  writeToClipboard(text);
  if (mode === "auto-paste") {
    await simulateCtrlV();
  }
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
