#!/usr/bin/env bash
# Post-install: compile the CLI binary and install it to ~/.pi/cron-jobs/bin/
set -e

# Find bun
BUN="${BUN_PATH:-}"
if [ -z "$BUN" ]; then
  BUN="$(command -v bun 2>/dev/null || echo "")"
fi
if [ -z "$BUN" ] && [ -f "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN" ]; then
  echo "pi-cron-jobs: bun not found — skipping binary build."
  echo "  Install bun (https://bun.sh) then run: bun run build && bun run install-bin"
  exit 0
fi

echo "pi-cron-jobs: building binary with $BUN..."
"$BUN" build src/cli.ts --compile --outfile dist/pi-cron-jobs

echo "pi-cron-jobs: installing binary..."
mkdir -p "$HOME/.pi/cron-jobs/bin"
cp dist/pi-cron-jobs "$HOME/.pi/cron-jobs/bin/pi-cron-jobs"
chmod +x "$HOME/.pi/cron-jobs/bin/pi-cron-jobs"

mkdir -p "$HOME/.local/bin"
ln -sf "$HOME/.pi/cron-jobs/bin/pi-cron-jobs" "$HOME/.local/bin/pi-cron-jobs"

echo "pi-cron-jobs: installed → ~/.local/bin/pi-cron-jobs"
echo "  Make sure ~/.local/bin is in your PATH."
