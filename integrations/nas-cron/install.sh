#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
runtime=/home/yuwk/cron
install -d -m 0755 "$runtime/resource-center" "$runtime/systemd"
install -m 0644 "$src/bookmark-onboarding.py" "$src/resource-center-cron.py" "$src/../cron_adapter.py" "$runtime/resource-center/"
for file in "$src"/systemd/*; do
  install -m 0644 "$file" "$runtime/systemd/$(basename "$file")"
  sudo -n ln -sfn "$runtime/systemd/$(basename "$file")" "/etc/systemd/system/$(basename "$file")"
done
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now resource-center-catalog.timer resource-center-validation.timer resource-center-bookmarks.timer
