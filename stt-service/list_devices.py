from __future__ import annotations

import json

import sounddevice as sd


def _hostapi_name(hostapi_index: int) -> str:
    hostapis = sd.query_hostapis()
    if 0 <= hostapi_index < len(hostapis):
        return str(hostapis[hostapi_index].get("name", "Unknown"))
    return "Unknown"


def _device_name(device: dict) -> str:
    name = str(device.get("name", "")).strip()
    return name if name else "Unnamed Device"


def main() -> None:
    devices = sd.query_devices()
    default_input, default_output = sd.default.device

    microphones: list[dict] = []
    outputs: list[dict] = []
    wasapi_outputs: list[dict] = []

    for index, device in enumerate(devices):
        hostapi = _hostapi_name(int(device.get("hostapi", -1)))
        name = _device_name(device)

        max_input = int(device.get("max_input_channels", 0))
        if max_input > 0:
            microphones.append(
                {
                    "id": str(index),
                    "name": name,
                    "hostapi": hostapi,
                    "channels": max_input,
                    "isDefault": index == default_input,
                }
            )

        max_output = int(device.get("max_output_channels", 0))
        if max_output > 0:
            item = {
                "id": str(index),
                "name": name,
                "hostapi": hostapi,
                "channels": max_output,
                "isDefault": index == default_output,
            }
            outputs.append(item)
            if "WASAPI" in hostapi.upper():
                wasapi_outputs.append(item)

    payload = {
        "microphones": microphones,
        "systemAudio": wasapi_outputs if wasapi_outputs else outputs,
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
