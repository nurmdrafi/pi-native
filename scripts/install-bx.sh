#!/bin/sh
# Install the pinned Brave Search CLI into the machine-local agent bin directory.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/bin/bx"
[ ! -x "$DEST" ] || exit 0

VERSION=1.7.0
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)  platform=linux-amd64;  hash=d45dd826436b95dac750e80e10e497a3feca3f8841fe51f940c0703f14cf0d39 ;;
  Linux:aarch64) platform=linux-arm64;  hash=9b0bbdc68ec9c56fdbd35807468a7124d4dd972c0c61c5355013a34eb8996068 ;;
  Darwin:x86_64) platform=darwin-amd64; hash=4090919a26045a0993aca0594cf06651a63e9f73575455cb62e759453c464dc9 ;;
  Darwin:arm64)  platform=darwin-arm64; hash=107f68945c0d9b147fef5a38aaa156a75ca744324b2d782053435cbc6b653863 ;;
  *) echo '!! bx: no pinned release for this OS/architecture' >&2; exit 1 ;;
esac

mkdir -p "$ROOT/bin"
stage=$(mktemp "$ROOT/bin/.bx.XXXXXXXX")
trap 'rm -f "$stage"' EXIT
trap 'exit 1' HUP INT TERM
url="https://github.com/brave/brave-search-cli/releases/download/v${VERSION}/bx-${VERSION}-${platform}"
curl -fsSL --proto '=https' --proto-redir '=https' --max-time 60 -o "$stage" "$url"
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 < "$stage")
else
  actual=$(sha256sum < "$stage")
fi
if [ "${actual%% *}" != "$hash" ]; then
  echo '!! bx: release checksum mismatch; not installing' >&2
  exit 1
fi
chmod 0755 "$stage"
mv -f "$stage" "$DEST"
printf '== bx: installed version %s into bin/\n' "$VERSION"
