#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/logseq-hud-do"
bin_dir="$HOME/.local/bin"
mkdir -p "$install_dir/logseq_hud_do" "$bin_dir"
cp "$source_dir"/logseq_hud_do/*.py "$install_dir/logseq_hud_do/"
cat > "$bin_dir/logseq-hud-do" <<'LAUNCHER'
#!/bin/sh
export PYTHONPATH="${XDG_DATA_HOME:-$HOME/.local/share}/logseq-hud-do"
exec python3 -m logseq_hud_do "$@"
LAUNCHER
chmod +x "$bin_dir/logseq-hud-do"
