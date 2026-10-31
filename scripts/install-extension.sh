#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(gnome-shell --version)
python3 - "$source_dir/extension/metadata.json" "$version" <<'PYTHON'
import json
import re
import sys
supported = json.load(open(sys.argv[1]))['shell-version']
match = re.fullmatch(r'GNOME Shell (\d+)(?:\..*)?', sys.argv[2])
if not match or match[1] not in supported:
    sys.exit(f"Supported GNOME Shell versions: {', '.join(supported)} (found {sys.argv[2]})")
PYTHON
extension_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/logseq-hud-do@local"
mkdir -p "$extension_dir/schemas" "$extension_dir/logseq_hud_do"
cp "$source_dir"/extension/*.js "$source_dir"/extension/*.css "$source_dir"/extension/metadata.json "$extension_dir/"
cp "$source_dir"/extension/schemas/*.xml "$extension_dir/schemas/"
cp "$source_dir"/logseq_hud_do/*.py "$extension_dir/logseq_hud_do/"
glib-compile-schemas --strict "$extension_dir/schemas"
printf '%s\n' 'Installed. Log out and back in, then run: gnome-extensions enable logseq-hud-do@local'
