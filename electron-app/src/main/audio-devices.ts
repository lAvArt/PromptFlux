import { spawn } from "node:child_process";

export interface AudioDeviceOption {
  id: string;
  name: string;
  hostapi: string;
  channels: number;
  isDefault: boolean;
}

export interface AudioDevicesPayload {
  microphones: AudioDeviceOption[];
  systemAudio: AudioDeviceOption[];
}

export async function listAudioDevices(scriptPath: string): Promise<AudioDevicesPayload> {
  return new Promise((resolve) => {
    const child = spawn("python", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ microphones: [], systemAudio: [] });
    }, 5_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        if (stderr.trim()) {
          console.error("[devices]", stderr.trim());
        }
        resolve({ microphones: [], systemAudio: [] });
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as AudioDevicesPayload;
        resolve({
          microphones: Array.isArray(parsed.microphones) ? parsed.microphones : [],
          systemAudio: Array.isArray(parsed.systemAudio) ? parsed.systemAudio : [],
        });
      } catch {
        resolve({ microphones: [], systemAudio: [] });
      }
    });

    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ microphones: [], systemAudio: [] });
    });
  });
}
