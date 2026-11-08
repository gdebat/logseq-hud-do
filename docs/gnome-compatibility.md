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

## Graph directory chooser API compatibility

The chooser uses the GTK 4 `Gtk.FileChooserNative` API with `SELECT_FOLDER`,
`get_file()`, explicit single selection, modal parenting, disabled folder creation,
and owned response/disconnect/destroy cleanup. Preferences closes the chooser on
`close-request` and `unrealize`; callbacks from obsolete choosers are ignored.
There are no Shell private API imports or major-version branches in this path.
`FileChooserNative` is deprecated since GTK 4.10 but remains available in all
five GTK release snapshots checked below. This preserves the existing GTK 4
requirement without requiring the newer `FileDialog` API.

| GNOME | GTK in checked maintained release manifest | Public chooser/lifecycle declarations | Live chooser results |
| --- | --- | --- | --- |
| [46](https://github.com/GNOME/gnome-build-meta/blob/gnome-46/elements/sdk/gtk.bst) | 4.14.5 | Checked | Not run |
| [47](https://github.com/GNOME/gnome-build-meta/blob/gnome-47/elements/sdk/gtk.bst) | 4.16.13 | Checked | Not run |
| [48](https://github.com/GNOME/gnome-build-meta/blob/gnome-48/elements/sdk/gtk.bst) | 4.18.6 | Checked | Not run |
| [49](https://github.com/GNOME/gnome-build-meta/blob/gnome-49/elements/sdk/gtk.bst) | 4.20.4 | Checked | Not run |
| [50](https://github.com/GNOME/gnome-build-meta/blob/gnome-50/elements/sdk/gtk.bst) | 4.22.5 | Checked | Not run |

Source review checked `gtk/deprecated/gtkfilechoosernative.h`,
`gtk/deprecated/gtkfilechooser.h` and `gtk/gtknativedialog.h` in each corresponding
GTK tag: constructor, selection getters/setters, show, modal, response and destroy
signatures are present. For example, see the
[4.14.5 constructor](https://github.com/GNOME/gtk/blob/4.14.5/gtk/deprecated/gtkfilechoosernative.h),
[4.22.5 chooser interface](https://github.com/GNOME/gtk/blob/4.22.5/gtk/deprecated/gtkfilechooser.h)
and [4.22.5 lifecycle](https://github.com/GNOME/gtk/blob/4.22.5/gtk/gtknativedialog.h).
The [GTK documentation](https://docs.gtk.org/gtk4/class.FileChooserNative.html)
explains its response and ownership rules. Maintained branch versions may change;
distributions can package different GTK and portal versions.

Investigation introspection found the chooser methods on local GTK 4.14.5 with
GJS 1.80.2, plus the `create-folders` property and `unrealize` signal. No chooser
was opened for that API check. Run the [chooser acceptance checklist](ui-acceptance.md#graph-directory-chooser)
on every supported major before claiming full runtime compatibility. Header
checks, metadata and Node doubles do not satisfy that live acceptance requirement.
