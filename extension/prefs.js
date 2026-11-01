import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {compileTextFilter, readHidden, writeHidden, unhideTask} from './model.js';

export default class Preferences extends ExtensionPreferences {
    _hiddenTasks(page, window, settings) {
        const group = new Adw.PreferencesGroup({title: 'Hidden Tasks'});
        page.add(group);
        const search = new Gtk.SearchEntry({placeholder_text: 'Search hidden tasks'});
        group.add(search);
        const all = new Adw.ActionRow({title: 'Unhide All'});
        const button = new Gtk.Button({label: 'Unhide All', valign: Gtk.Align.CENTER});
        all.add_suffix(button);
        group.add(all);
        button.connect('clicked', () => {
            const dialog = new Gtk.MessageDialog({transient_for: window, modal: true,
                text: 'Unhide all tasks?', buttons: Gtk.ButtonsType.NONE});
            dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
            dialog.add_button('Unhide All', Gtk.ResponseType.ACCEPT);
            dialog.set_default_response(Gtk.ResponseType.CANCEL);
            dialog.connect('response', (_dialog, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    try {
                        writeHidden(settings, []);
                        group.description = '';
                    } catch (error) {
                        group.description = error.message;
                        return;
                    }
                }
                dialog.destroy();
            });
            dialog.present();
        });
        let rows = [];
        const render = () => {
            for (const row of rows)
                group.remove(row);
            rows = [];
            const query = search.text.toLocaleLowerCase();
            for (const record of readHidden(settings)) {
                const subtitle = [record.graph, record.scheduled].filter(Boolean).join(' · ');
                if (!`${record.description} ${subtitle}`.toLocaleLowerCase().includes(query))
                    continue;
                const row = new Adw.ActionRow({title: record.description, subtitle, use_markup: false});
                const unhide = new Gtk.Button({label: 'Unhide', valign: Gtk.Align.CENTER});
                unhide.connect('clicked', () => {
                    try {
                        unhideTask(settings, record.key);
                        group.description = '';
                    } catch (error) {
                        group.description = error.message;
                    }
                });
                row.add_suffix(unhide);
                rows.push(row);
                group.add(row);
            }
        };
        search.connect('search-changed', render);
        const signal = settings.connect('changed::hidden-tasks-v2', render);
        window.connect('close-request', () => { settings.disconnect(signal); return false; });
        render();
    }

    fillPreferencesWindow(window) {
        const [, contents] = Gio.File.new_for_path(`${this.path}/logseq_hud_do/graph-roots.json`).load_contents(null);
        const graphRoots = JSON.parse(new TextDecoder().decode(contents));
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Logseq HUD->Do', icon_name: 'view-list-symbolic'});
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
            description: 'Hide matching description lines only. Start with ^; use character classes and at most one * or +. Groups, alternatives and counts are unsupported. Empty list disables line filtering.'});
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
        const blocks = new Adw.PreferencesGroup({title: 'Task block filters',
            description: 'Literal markers must occupy separate lines; surrounding whitespace is ignored. The first matching end closes a block; blocks do not nest. Unclosed blocks are kept. Blank markers are ignored; for duplicate starts the first pair wins. Empty list disables block filtering.'});
        page.add(blocks);
        const blockRows = [];
        const saveBlocks = () => settings.set_value('task-block-filters',
            new GLib.Variant('a(ss)', blockRows.map(([start, end]) => [start.text, end.text])));
        const addBlock = (start, end) => {
            const startRow = new Adw.EntryRow({title: 'Start marker'});
            const endRow = new Adw.EntryRow({title: 'End marker'});
            startRow.text = start;
            endRow.text = end;
            const pair = [startRow, endRow];
            blockRows.push(pair);
            for (const row of pair) {
                blocks.add(row);
                row.connect('changed', saveBlocks);
            }
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Remove block filter'});
            remove.connect('clicked', () => {
                blockRows.splice(blockRows.indexOf(pair), 1);
                for (const row of pair)
                    blocks.remove(row);
                saveBlocks();
            });
            startRow.add_suffix(remove);
        };
        for (const [start, end] of settings.get_value('task-block-filters').deep_unpack())
            addBlock(start, end);
        const addBlockRow = new Adw.ActionRow({title: 'Add block filter'});
        const addBlockButton = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        addBlockButton.connect('clicked', () => { addBlock(':LOGBOOK:', ':END:'); saveBlocks(); });
        addBlockRow.add_suffix(addBlockButton);
        blocks.add(addBlockRow);
        this._hiddenTasks(page, window, settings);
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
