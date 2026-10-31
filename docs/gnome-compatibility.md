# GNOME compatibility evidence

All five metadata targets (46, 47, 48, 49, 50) have been statically checked
against the official GNOME porting guides:

- [46](https://gjs.guide/extensions/upgrading/gnome-shell-46.html): explicit expand properties on St.Button; literal St.Label text; ScrollView.set_child.
- [47](https://gjs.guide/extensions/upgrading/gnome-shell-47.html): synchronous fillPreferencesWindow remains valid when awaited; PopupBaseMenuItem changes do not alter our child API.
- [48](https://gjs.guide/extensions/upgrading/gnome-shell-48.html): St vertical is deprecated. Both vertical boxes detect orientation on the prototype, using Clutter.Orientation.VERTICAL when available. Only older versions use vertical.
- [49](https://gjs.guide/extensions/upgrading/gnome-shell-49.html): removed Meta.Rectangle, AppMenuButton and Clutter actions are not used.
- [50](https://gjs.guide/extensions/upgrading/gnome-shell-50.html): removed X11 restart APIs are not used; existing GLib timeouts remain appropriate for recurring callbacks.

Shared interfaces used: Extension.getSettings/openPreferences, PanelMenu.Button,
Main.panel.addToStatusArea, PopupMenu items/actions/open-state-changed,
St actors, Gio async subprocesses, GLib sources and Gtk4/libadwaita preferences.
No version-number branches or new runtime dependencies are introduced.
Installer acceptance derives from metadata. Tests cover both layout API shapes,
all five installation targets and rejection of older/newer/unrecognised versions.
The local GJS model tests use GJS 1.80.2; Node actor doubles are not Shell runtimes.

Live-session status: **none tested** for 46, 47, 48, 49 or 50. Static checking
and metadata declaration are not claims of verified runtime compatibility.
Before runtime acceptance, run the README live checklist separately on every
major: enable/preferences, both Shell themes, scaling/scrolling/focus, protocol
handler and missing handler, periodic/manual/open/settings/midnight refresh,
errors and disable during subprocess work. Use only disposable graphs.
Automated CSS checks verify badge contrast >= 4.5:1 and inherited ordinary text;
they cannot prove Shell theme rendering, layout or accessibility in a session.
