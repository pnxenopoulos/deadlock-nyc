#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."

# Bun and wasm-pack commonly live here even when a non-login shell omits them.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"

cd "$ROOT_DIR"

echo "[1/5] Refreshing manifests from GameTracking..."
bun run sync

echo "[2/5] Extracting referenced images from the local Deadlock install..."
bun run extract-images

echo "[3/5] Optimizing images..."
bun run images

echo "[4/5] Rebuilding the Boon WebAssembly module..."
bun run wasm

echo "[5/5] Verifying the production build..."
bun run build

echo "Refresh complete. Review the generated changes with: git status --short"
