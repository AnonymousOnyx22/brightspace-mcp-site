#!/bin/bash
# Brightspace MCP installer for Mac and Linux.
#   curl -fsSL https://brightspacemcp.com/install.sh | bash -s -- bmp_your_key
# Installs a private copy of Node.js if needed (no admin password), then runs
# setup. Everything stays in your user folder.
set -euo pipefail

KEY="${1:-}"
case "$(uname -s)" in
  Darwin) OS=darwin; HOME_DIR="$HOME/Library/Application Support/Brightspace MCP" ;;
  Linux)  OS=linux;  HOME_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/brightspace-mcp" ;;
  *) echo "This installer is for Mac and Linux. On Windows, use the setup file from brightspacemcp.com."; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "Unsupported processor: $(uname -m)"; exit 1 ;;
esac

if [ -n "$KEY" ] && ! [[ "$KEY" =~ ^bmp_[A-Za-z0-9]+_[A-Za-z0-9_-]{16,}$ ]]; then
  echo "That key doesn't look right. Copy it again from the page you saw after checkout."
  exit 1
fi

echo
echo "  Brightspace MCP setup"
echo "  Connects D2L Brightspace to your AI apps and turns on alerts."
echo

node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }

NODE_DIR="$HOME_DIR/node"
if ! node_ok; then
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "  Getting Node.js (one time, about 50 MB)..."
    BASE="https://nodejs.org/dist/latest-v22.x"
    LINE="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -E "node-v[0-9.]+-$OS-$ARCH\.tar\.gz$" | head -n1)"
    SUM="${LINE%% *}"
    FILE="${LINE##* }"
    [ -n "$FILE" ] || { echo "  Couldn't find Node.js for this computer."; exit 1; }
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fL --progress-bar "$BASE/$FILE" -o "$TMP/node.tar.gz"
    if command -v shasum >/dev/null 2>&1; then
      echo "$SUM  $TMP/node.tar.gz" | shasum -a 256 -c - >/dev/null
    else
      echo "$SUM  $TMP/node.tar.gz" | sha256sum -c - >/dev/null
    fi
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xzf "$TMP/node.tar.gz" -C "$NODE_DIR" --strip-components=1
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi

ARGS=(-y brightspace-d2l-mcp@latest setup)
[ -n "$KEY" ] && ARGS+=(--key "$KEY")
# The script itself arrives on stdin, so give setup the keyboard for its questions.
if [ -r /dev/tty ] && { : < /dev/tty; } 2>/dev/null; then
  npx "${ARGS[@]}" < /dev/tty
else
  npx "${ARGS[@]}"
fi
