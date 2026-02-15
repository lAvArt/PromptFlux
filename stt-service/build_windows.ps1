$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

Write-Host "[stt-build] Ensuring PyInstaller is available..."
python -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
  python -m pip install --upgrade pyinstaller | Out-Null
}

Get-Process promptflux-stt,promptflux-list-devices -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

$distPath = Join-Path $PSScriptRoot "dist"
$workPath = Join-Path $PSScriptRoot "build\pyinstaller"
$specPath = $workPath

if (Test-Path $distPath) {
  Remove-Item -Path $distPath -Recurse -Force
}
if (Test-Path $workPath) {
  Remove-Item -Path $workPath -Recurse -Force
}

Write-Host "[stt-build] Building promptflux-stt executable..."
python -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name promptflux-stt `
  --distpath $distPath `
  --workpath $workPath `
  --specpath $specPath `
  --collect-data faster_whisper `
  --collect-binaries ctranslate2 `
  --collect-binaries av `
  --hidden-import faster_whisper `
  --hidden-import ctranslate2 `
  --hidden-import tokenizers `
  --hidden-import av `
  --hidden-import sounddevice `
  --hidden-import websockets.server `
  --hidden-import websockets.legacy.server `
  --exclude-module torch `
  --exclude-module torchvision `
  --exclude-module torchaudio `
  --exclude-module transformers `
  --exclude-module bitsandbytes `
  --exclude-module onnxruntime `
  --exclude-module pandas `
  --exclude-module scipy `
  --exclude-module cv2 `
  --exclude-module h5py `
  --exclude-module matplotlib `
  --exclude-module IPython `
  --exclude-module pytest `
  server.py

Write-Host "[stt-build] Building promptflux-list-devices executable..."
python -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name promptflux-list-devices `
  --distpath $distPath `
  --workpath $workPath `
  --specpath $specPath `
  --exclude-module matplotlib `
  --exclude-module IPython `
  --exclude-module pytest `
  list_devices.py

Write-Host "[stt-build] Completed."
