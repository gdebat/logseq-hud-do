import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {compileTextFilter} from './model.js';

export default class Preferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const [, contents] = Gio.File.new_for_path(`${this.path}/logseq_hud_do/graph-roots.json`).load_contents(null);
        const graphRoots = JSON.parse(new TextDecoder().decode(contents));
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Logseq HUD Do', icon_name: 'view-list-symbolic'});
        window.add(page);
        const graphs = new Adw.PreferencesGroup({title: 'Graphs', description: 'Absolute graph directories containing pages or journals. Graphs are read-only.'});
        page.add(graphs);
        const rows = [];
        const save = () => settings.set_value('graphs', new GLib.Variant('a(ss)', rows.map(row => [row.path, row.name])));
        const add = (path, name) => {
            const row = new Adw.ActionRow({title: name || path, subtitle: path});
            row.path = path;
            row.name = name;
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Remove graph'});
            remove.connect('clicked', () => {
                rows.splice(rows.indexOf(row), 1);
                graphs.remove(row);
                save();
            });
            row.add_suffix(remove);
            rows.push(row);
            graphs.add(row);
        };
        for (const [path, name] of settings.get_value('graphs').deep_unpack())
            add(path, name);
        const entry = new Adw.EntryRow({title: 'Absolute graph directory'});
        const name = new Adw.EntryRow({title: 'Display name (optional)'});
        graphs.add(entry);
        graphs.add(name);
        const addRow = new Adw.ActionRow({title: 'Add graph'});
        const button = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        addRow.add_suffix(button);
        graphs.add(addRow);
        button.connect('clicked', () => {
            const path = entry.text.trim();
            const directory = Gio.File.new_for_path(path);
            if (!GLib.path_is_absolute(path) || !directory.query_exists(null) ||
                !graphRoots.some(child => directory.get_child(child).query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY)) {
                addRow.subtitle = 'Enter an existing absolute graph directory with non-symlink pages/ or journals/.';
                return;
            }
            if (rows.some(row => row.path === path)) {
                addRow.subtitle = 'This directory is already configured.';
                return;
            }
            add(path, name.text.trim());
            save();
            entry.text = '';
            name.text = '';
            addRow.subtitle = '';
        });
        const filters = new Adw.PreferencesGroup({title: 'Task text filters',
            description: 'Hide matching description lines only. Start with ^; use character classes and at most one * or +. Groups, alternatives and counts are unsupported. Empty list disables filtering.'});
        page.add(filters);
        const filterRows = [];
        const saveFilters = () => settings.set_strv('task-text-filters', filterRows.map(row => row.text));
        const addFilter = pattern => {
            const row = new Adw.EntryRow({title: 'Line regex'});
            row.text = pattern;
            const validate = () => {
                try {
                    compileTextFilter(row.text);
                    row.title = 'Line regex';
                } catch (error) {
                    row.title = `Ignored: ${error.message}`;
                }
            };
            row.connect('changed', () => { validate(); saveFilters(); });
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Remove filter'});
            remove.connect('clicked', () => {
                filterRows.splice(filterRows.indexOf(row), 1);
                filters.remove(row);
                saveFilters();
            });
            row.add_suffix(remove);
            filterRows.push(row);
            filters.add(row);
            validate();
        };
        for (const pattern of settings.get_strv('task-text-filters'))
            addFilter(pattern);
        const addFilterRow = new Adw.ActionRow({title: 'Add text filter'});
        const addFilterButton = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        addFilterButton.connect('clicked', () => { addFilter('^property::'); saveFilters(); });
        addFilterRow.add_suffix(addFilterButton);
        filters.add(addFilterRow);
        const refresh = new Adw.PreferencesGroup({title: 'Refresh and display'});
        page.add(refresh);
        for (const [key, title] of [
            ['refresh-interval', 'Refresh interval (seconds)'],
            ['horizon', 'Upcoming horizon (days)'],
        ]) {
            const [, bounds] = settings.settings_schema.get_key(key).get_range().deep_unpack();
            const [lower, upper] = bounds.deep_unpack();
            const row = new Adw.SpinRow({title, adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 10})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            refresh.add(row);
        }
        for (const [key, title] of [
            ['show-overdue', 'Show Overdue'], ['show-upcoming', 'Show Upcoming'],
            ['show-today-count', 'Show Today count in panel'],
        ]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            refresh.add(row);
        }
    }
}
