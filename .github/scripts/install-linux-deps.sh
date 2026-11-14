#!/usr/bin/env bash
# System libraries Tauri needs to build on Debian/Ubuntu.
# https://v2.tauri.app/start/prerequisites/#linux
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential \
  curl \
  file \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  patchelf \
  wget
