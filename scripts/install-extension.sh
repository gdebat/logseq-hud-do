#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(gnome-shell --version)
case "$version" in
    'GNOME Shell 46.'*) ;;
    *) echo "Supported GNOME Shell version: 46 (found $version)" >&2; exit 1 ;;
esac
extension_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/logseq-hud-do@local"
mkdir -p "$extension_dir/schemas" "$extension_dir/logseq_hud_do"
cp "$source_dir"/extension/*.js "$source_dir"/extension/*.css "$source_dir"/extension/metadata.json "$extension_dir/"
cp "$source_dir"/extension/schemas/*.xml "$extension_dir/schemas/"
cp "$source_dir"/logseq_hud_do/*.py "$extension_dir/logseq_hud_do/"
glib-compile-schemas --strict "$extension_dir/schemas"
printf '%s\n' 'Installed. Log out and back in, then run: gnome-extensions enable logseq-hud-do@local'
