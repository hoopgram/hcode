#!/bin/sh
set -eu

if [ -n "${HCODE_RELEASE_URL:-}" ]; then
  base=${HCODE_RELEASE_URL%/}
else
  # /releases/latest excludes prereleases. Until macOS notarization exists, native releases are
  # intentionally prereleases, so discover the newest published release from the anonymous API.
  api=${HCODE_RELEASES_URL:-https://api.github.com/repos/hoopgram/hcode/releases?per_page=1}
  tag=$(curl -fsSL --proto '=https' --tlsv1.2 -H 'Accept: application/vnd.github+json' "$api" |
    sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\(v[0-9][0-9.]*\)".*/\1/p' | head -n 1)
  case "$tag" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "could not discover the latest published hcode release" >&2; exit 69 ;; esac
  base=https://github.com/hoopgram/hcode/releases/download/$tag
fi
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  Linux-x86_64) target=linux-x64 ;;
  *) echo "unsupported hcode native platform: $(uname -s)-$(uname -m)" >&2; exit 64 ;;
esac
if [ -e /etc/NIXOS ]; then
  echo "NixOS should install hcode through its flake/profile; the generic Linux binary is not selected." >&2
  exit 69
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/hcode-install.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
curl -fsSL --proto '=https' --tlsv1.2 "$base/native-manifest.json" -o "$stage/native-manifest.json"
curl -fsSL --proto '=https' --tlsv1.2 "$base/hcode-$target" -o "$stage/hcode-$target"
curl -fsSL --proto '=https' --tlsv1.2 "$base/hcode-$target.sha256" -o "$stage/hcode-$target.sha256"
cd "$stage"
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "hcode-$target.sha256"
else shasum -a 256 -c "hcode-$target.sha256"
fi
chmod 700 "hcode-$target"
"$stage/hcode-$target" _install-native "$stage/hcode-$target" "$stage/native-manifest.json"
