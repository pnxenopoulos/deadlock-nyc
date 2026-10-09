#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."

# Bun and wasm-pack commonly live here even when a non-login shell omits them.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"

cd "$ROOT_DIR"

echo "[1/6] Refreshing manifests from GameTracking..."
bun run sync

echo "[2/6] Building the embedded Boon name catalog..."
bun run catalog

echo "[3/6] Extracting referenced images from the local Deadlock install..."
bun run extract-images

echo "[4/6] Optimizing images..."
bun run images

echo "[5/6] Rebuilding the Boon WebAssembly module..."
bun run wasm

echo "[6/6] Verifying the production build..."
bun run build

echo "Refresh complete. Review the generated changes with: git status --short"
