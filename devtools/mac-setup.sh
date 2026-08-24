#!/usr/bin/env bash
# Prepare a macOS (Apple Silicon) build of .lcl.
#
# Run this ON THE MAC, from the repo root. It exists because two things cannot
# be done from Windows:
#
#   1. The llama.cpp macOS binaries ship as a tarball of dylibs held together by
#      SYMLINKS (libllama.dylib -> libllama.0.dylib -> libllama.0.0.10107.dylib)
#      and marked executable. Extracting that on Windows silently drops both,
#      leaving a build that fails to load its own engine.
#   2. electron-builder cannot produce a .dmg anywhere but macOS — it needs
#      hdiutil.
#
# So the tarball is committed as-is and unpacked here, natively.
#
#   ./tools/mac-setup.sh          prepare only
#   ./tools/mac-setup.sh --build  prepare, then build the .dmg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$ROOT/engine/runtimes/llama.cpp/mac-arm64"
TARBALL="$RT/llama-b10107-bin-macos-arm64.tar.gz"

say() { printf "\033[1m%s\033[0m\n" "$*"; }
warn() { printf "\033[33m%s\033[0m\n" "$*"; }
die() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this must run on macOS (found $(uname -s))"
[ "$(uname -m)" = "arm64" ] || warn "expected Apple Silicon (found $(uname -m)) — Metal needs arm64"

say "1. Unpacking the llama.cpp engine (preserving symlinks + exec bits)"
if [ ! -f "$TARBALL" ]; then
    warn "   tarball missing; downloading b10107 for macos-arm64"
    mkdir -p "$RT"
    curl -fL --retry 3 -o "$TARBALL" \
      "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-macos-arm64.tar.gz"
fi
# --strip-components drops the llama-bXXXXX/ prefix so paths match engine.json
tar -xzf "$TARBALL" -C "$RT" --strip-components=1
chmod +x "$RT"/llama-* "$RT"/ggml-* 2>/dev/null || true

[ -x "$RT/llama-server" ] || die "llama-server missing or not executable after extract"
# The engine's public name is .lcl.engine — engine.json's mac build points at
# that binary name, so Activity Monitor shows our engine, not a generic tool.
# The dylibs keep their upstream names: the binary links against them by name.
say "   llama-server ready"
if [ -e "$RT/libggml-metal.dylib" ]; then
    say "   Metal backend present — GPU acceleration available"
else
    warn "   no Metal dylib found; inference would fall back to CPU"
fi

say "2. Checking the symlink chain survived"
broken=0
for l in "$RT"/*.dylib; do
    if [ -L "$l" ] && [ ! -e "$l" ]; then warn "   broken symlink: $(basename "$l")"; broken=1; fi
done
[ "$broken" -eq 0 ] && say "   all dylib links resolve" || die "broken links — re-extract on macOS"

say "3. Quick engine smoke test"
if "$RT/llama-server" --help >/dev/null 2>&1; then
    say "   the engine runs on this machine"
else
    warn "   llama-server did not run. On first launch macOS may quarantine it:"
    warn "     xattr -dr com.apple.quarantine \"$RT\""
fi

say "4. Node dependencies"
cd "$ROOT/app"
[ -d node_modules ] || npm install

say "5. Models"
MODELS="$ROOT/engine/models"
count=$(ls "$MODELS"/*.gguf 2>/dev/null | wc -l | tr -d ' ')
say "   $count GGUF file(s) in engine/models"
if [ "$count" -eq 0 ]; then
    warn "   none present. Copy them from the Windows machine, or the app will"
    warn "   start with no model. On 16 GB unified memory the practical picks are"
    warn "   the 1.5B/4B models; a 9B needs the machine fairly quiet."
fi

if [ "${1:-}" = "--build" ]; then
    say "6. Building the .dmg"
    npx electron-builder --mac --config builder-config.json
    say "   done: $ROOT/dist"
else
    say "Prepared. To build the installer:  ./tools/mac-setup.sh --build"
    say "To run from source instead:        cd app && npm start"
fi
