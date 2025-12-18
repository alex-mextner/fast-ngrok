#!/bin/bash
# Build native TUI library for all supported platforms
set -e

cd "$(dirname "$0")"

echo "Building for macOS arm64..."
zig build -Dtarget=aarch64-macos -Doptimize=ReleaseFast
cp zig-out/lib/libtui.dylib lib/darwin-arm64/

echo "Building for macOS x64..."
zig build -Dtarget=x86_64-macos -Doptimize=ReleaseFast
cp zig-out/lib/libtui.dylib lib/darwin-x64/

echo "Building for Linux x64..."
zig build -Dtarget=x86_64-linux-gnu -Doptimize=ReleaseFast
cp zig-out/lib/libtui.so lib/linux-x64/

echo "Done! Libraries built:"
ls -la lib/*/
