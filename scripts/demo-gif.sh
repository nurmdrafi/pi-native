#!/bin/sh
# Convert a screen recording into the README demo GIF (docs/assets/demo.gif).
# Pipeline: trim to duration, 10 fps, 800 px wide, two-pass palette GIF, 3 MiB guard.
# Usage: scripts/demo-gif.sh <input-video> [duration-seconds] [output.gif] [start-seconds]
# The input must be a real recording per docs/assets/demo-placeholder.md:
# one permission-gate confirmation, one dashboard card, about 15 seconds.
set -eu

in=${1:?usage: scripts/demo-gif.sh <input-video> [duration-seconds] [output.gif]}
dur=${2:-15}
out=${3:-docs/assets/demo.gif}
start=${4:-0}
max_bytes=3145728

palette=$(mktemp /tmp/demo-palette.XXXXXX.png)
trap 'rm -f "$palette"' EXIT

# pass 1: build the palette from the trimmed, scaled frames
ffmpeg -hide_banner -loglevel error -y -ss "$start" -i "$in" -t "$dur" \
  -vf 'fps=10,scale=800:-2:flags=lanczos,palettegen=max_colors=96' \
  "$palette"

# pass 2: encode the GIF with that palette
ffmpeg -hide_banner -loglevel error -y -ss "$start" -i "$in" -i "$palette" -t "$dur" \
  -lavfi '[0:v]fps=10,scale=800:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4' \
  "$out"

bytes=$(wc -c < "$out" | tr -d ' ')
if [ "$bytes" -gt "$max_bytes" ]; then
  echo "FAIL: $out is $bytes bytes (limit $max_bytes). Lower fps, width, or max_colors." >&2
  exit 1
fi
echo "OK: $out ($bytes bytes, ${dur}s, 10 fps, 800 px)"
