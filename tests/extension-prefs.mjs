import {compileTextFilter, defaultTextFilters, defaultBlockFilters, readHidden, writeHidden, unhideTask, visibleTasks} from '../extension/model.js';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
class Widget {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.handlers = {}; this.text = ''; }
    remove(x) { this.children.splice(this.children.indexOf(x), 1); }
    add(x) { this.children.push(x); }
    add_suffix(x) { this.add(x); }
    connect(signal, callback) {
        this.connections ??= new Map();
        const id = (this.nextSignalId ?? 0) + 1;
        this.nextSignalId = id;
        this.connections.set(id, {signal, callback});
        this.handlers[signal] = (...args) => {
            let result;
            for (const handler of [...this.connections.values()]) {
                if (handler.signal === signal)
                    result = handler.callback(...args);
            }
            return result;
        };
        return id;
    }
    disconnect(id) { this.connections.delete(id); }
}
const xml = fs.readFileSync('extension/schemas/org.gnome.shell.extensions.logseq-hud-do.gschema.xml', 'utf8');
const ranges = Object.fromEntries([...xml.matchAll(/<key name="([^"]+)"[^>]*>.*?<range min="(\d+)" max="(\d+)"/g)].map(m => [m[1], [+m[2], +m[3]]]));
const sharedRoots = JSON.parse(fs.readFileSync('logseq_hud_do/graph-roots.json', 'utf8'));
const graphRoots = process.argv[2] ? JSON.parse(process.argv[2]) : sharedRoots;
let roots = {};
const queriedRoots = new Set();
const bindings = [];
let saved = 0;
const settings = {
    registry: '{"version":2,"tasks":[]}',
    get_string: () => settings.registry,
    set_string: (_key, value) => { settings.registry = value; settings.onHidden(); },
    connect: (_signal, callback) => { settings.onHidden = callback; return 1; },
    disconnect() { settings.disconnections = (settings.disconnections ?? 0) + 1; },
    get_strv: () => defaultTextFilters,
    set_strv: (key, patterns) => { assert.equal(key, 'task-text-filters'); settings.patterns = patterns; },
    get_value: key => ({deep_unpack: () => key === 'task-block-filters' ? defaultBlockFilters : []}),
    set_value: (key, value) => { if (key === 'task-block-filters') settings.blocks = value.value; else { saved++; settings.graphs = value.value; } },
    settings_schema: {get_key: key => ({get_range: () => ({deep_unpack: () => ['range', {deep_unpack: () => ranges[key]}]})})},
    bind: (key, row, property) => bindings.push([key, row, property]),
};
const choosers = [];
let chooserFailure = null;
class FolderChooser extends Widget {
    static new(title, parent, action, accept, cancel) {
        if (chooserFailure === 'construct')
            throw new Error('constructor failed');
        const chooser = new FolderChooser({title, parent, action, accept, cancel});
        choosers.push(chooser);
        return chooser;
    }
    set_modal(value) { this.modal = value; }
    set_select_multiple(value) { this.multiple = value; }
    set_create_folders(value) { this.createFolders = value; }
    show() {
        if (chooserFailure === 'show')
            throw new Error('show failed');
        this.shown = true;
    }
    get_file() {
        if (chooserFailure === 'get')
            throw new Error('selection failed');
        return this.file;
    }
    destroy() { this.destroyCount = (this.destroyCount ?? 0) + 1; }
}
const context = vm.createContext({
    TextDecoder, compileTextFilter, readHidden, writeHidden, unhideTask,
    Adw: {PreferencesPage: Widget, PreferencesGroup: Widget, ActionRow: Widget, EntryRow: Widget, SpinRow: Widget, SwitchRow: Widget},
    Gtk: {FileChooserNative: FolderChooser, FileChooserAction: {SELECT_FOLDER: 2}, MessageDialog: Widget, ButtonsType: {NONE: 0}, ResponseType: {CANCEL: 0, ACCEPT: 1, DELETE_EVENT: -4}, SearchEntry: Widget, Button: Widget, Adjustment: Widget, Align: {CENTER: 0}},
    GLib: {path_is_absolute: path => path.startsWith('/'), Variant: class { constructor(type, value) { assert.equal(type, 'a(ss)'); this.value = value; } }},
    Gio: {SettingsBindFlags: {DEFAULT: 0}, FileQueryInfoFlags: {NOFOLLOW_SYMLINKS: 1}, FileType: {DIRECTORY: 2},
        File: {new_for_path: path => ({load_contents: () => [true, fs.readFileSync(path)], query_exists: () => true, get_child: name => (queriedRoots.add(name), {query_file_type: flags => {assert.equal(flags, 1); return roots[name];}})})}},
    ExtensionPreferences: class {path = '.'; getSettings() {return settings;}},
});
vm.runInContext(fs.readFileSync('extension/prefs.js', 'utf8').replace(/^import .*;\n/gm, '').replace('export default class Preferences', 'globalThis.Prefs = class Preferences'), context);
const window = new Widget();
new context.Prefs().fillPreferencesWindow(window);
for (const [key, row] of bindings.filter(([, row]) => row.adjustment))
    assert.deepEqual([row.adjustment.lower, row.adjustment.upper], ranges[key]);
assert.equal(bindings.filter(([, row]) => row.adjustment).length, 2);
const graphs = window.children[0].children[0];
const entry = graphs.children[0];
const addRow = graphs.children[2];
for (const fixture of [...graphRoots.map(name => ({[name]: 3})), Object.fromEntries(graphRoots.map(name => [name, 3])), {}, {unsupported: 2}, ...sharedRoots.filter(name => !graphRoots.includes(name)).map(name => ({[name]: 2}))]) {
    roots = fixture;
    entry.text = '/fixture';
    addRow.children[0].handlers.clicked();
    assert.match(addRow.subtitle, /non-symlink/);
    assert.equal(saved, 0);
}
for (const name of graphRoots) {
    roots = {[name]: 2};
    entry.text = '/' + name;
    addRow.children[0].handlers.clicked();
}
assert.equal(saved, graphRoots.length);
assert.deepEqual([...queriedRoots].sort(), [...graphRoots].sort());
console.log('Preferences bounds and graph validation passed');

const filters = window.children[0].children[1];
const filter = filters.children[0];
filter.text = '[';
filter.handlers.changed();
assert.match(filter.title, /Ignored/);
filter.text = '^private::';
filter.handlers.changed();
assert.equal(filter.title, 'Line regex');
assert.equal(settings.patterns[0], '^private::');
filters.children[1].children[0].handlers.clicked();
assert.equal(settings.patterns.length, 2);
filter.children[0].handlers.clicked();
assert.equal(settings.patterns.length, 1);

const blocks = window.children[0].children[2];
assert.equal(blocks.children[0].text, ':LOGBOOK:');
assert.equal(blocks.children[1].text, ':END:');
blocks.children[0].text = 'BEGIN';
blocks.children[0].handlers.changed();
assert.equal(JSON.stringify(settings.blocks), JSON.stringify([['BEGIN', ':END:']]));
blocks.children[1].text = 'END';
blocks.children[1].handlers.changed();
assert.equal(settings.blocks[0][1], 'END');
blocks.children[2].children[0].handlers.clicked();
assert.equal(settings.blocks.length, 2);
blocks.children[0].children[0].handlers.clicked();
assert.equal(JSON.stringify(settings.blocks), JSON.stringify(defaultBlockFilters));

const hidden = window.children[0].children[3];
const records = [
    {key: JSON.stringify(['/graph', 'Page', 'First task', '2026-11-01']), description: 'First task', graph: 'Personal', scheduled: '2026-11-01'},
    {key: JSON.stringify(['/graph', 'Page', 'Second task', null]), description: 'Second task', graph: 'Work', scheduled: null},
];
writeHidden(settings, records);
assert.equal(hidden.children[2].title, 'First task');
assert.equal(hidden.children[2].subtitle, 'Personal · 2026-11-01');
assert(!JSON.stringify(hidden.children).includes('opaque-one'));
hidden.children[0].text = 'work';
hidden.children[0].handlers['search-changed']();
assert.equal(hidden.children.length, 3);
assert.equal(hidden.children[2].title, 'Second task');
hidden.children[2].children[0].handlers.clicked();
assert.equal(readHidden(settings).length, 1);
assert.equal(hidden.children.length, 2);
hidden.children[0].text = '';
hidden.children[0].handlers['search-changed']();
let confirmation;
Widget.prototype.add_button = function () { confirmation = this; };
Widget.prototype.set_default_response = function (value) { this.defaultResponse = value; };
Widget.prototype.present = function () {};
Widget.prototype.destroy = function () { this.destroyed = true; };
hidden.children[1].children[0].handlers.clicked();
assert.equal(confirmation.defaultResponse, context.Gtk.ResponseType.CANCEL);
confirmation.handlers.response(confirmation, context.Gtk.ResponseType.CANCEL);
assert.equal(readHidden(settings).length, 1);
hidden.children[1].children[0].handlers.clicked();
confirmation.handlers.response(confirmation, context.Gtk.ResponseType.ACCEPT);
assert.equal(readHidden(settings).length, 0);

for (const raw of ['{', 'null', '{}', '[]', '{"version":99,"tasks":[]}',
    '{"version":2,"tasks":null}', JSON.stringify({version: 2, tasks: [null, {}, {key: records[0].key}]})]) {
    settings.registry = raw;
    const safeWindow = new Widget();
    new context.Prefs().fillPreferencesWindow(safeWindow);
    const group = safeWindow.children[0].children[3];
    assert.equal(group.children.length, 2);
    group.children[0].text = 'task';
    group.children[0].handlers['search-changed']();
    group.children[1].children[0].handlers.clicked();
    confirmation.handlers.response(confirmation, context.Gtk.ResponseType.ACCEPT);
    assert.equal(readHidden(settings).length, 0);
}
settings.registry = JSON.stringify({version: 2, tasks: [null, ...records, {},
    {...records[0], key: 'invalid'}, {...records[0], description: null},
    {...records[0], scheduled: 42}, {...records[0], graph: null}]});
const mixedWindow = new Widget();
new context.Prefs().fillPreferencesWindow(mixedWindow);
assert.equal(readHidden(settings).length, 2);
const mixed = mixedWindow.children[0].children[3];
assert.equal(mixed.children.length, 4);
mixed.children[2].children[0].handlers.clicked();
assert.equal(readHidden(settings).length, 1);

assert(JSON.parse(settings.registry).tasks.includes(null));
const remaining = mixed.children[2];
for (const raw of ['{', 'null', '{}', '[]', '{"version":99,"tasks":[]}', '{"version":2,"tasks":null}']) {
    settings.registry = raw;
    remaining.children[0].handlers.clicked();
    assert.equal(settings.registry, raw);
    assert.match(mixed.description, /No changes were saved/);
}

const successfulWrite = settings.set_string;
writeHidden(settings, records);
hidden.children[0].text = '';
hidden.children[0].handlers['search-changed']();
const previousRegistry = settings.registry;
settings.set_string = () => false;
hidden.children[2].children[0].handlers.clicked();
assert.match(hidden.description, /could not be saved/i);
assert.equal(settings.registry, previousRegistry);
assert.equal(hidden.children[2].title, 'First task');
settings.set_string = successfulWrite;
hidden.children[2].children[0].handlers.clicked();
assert.equal(readHidden(settings).length, 1);
assert.equal(hidden.description, '');

writeHidden(settings, records);
const beforeReset = settings.registry;
const hiddenTask = {graph_path: '/graph', source_page: 'Page', content: 'First task', scheduled: '2026-11-01'};
const taskData = {today: [hiddenTask], overdue: [], upcoming: []};
hidden.children[1].children[0].handlers.clicked();
settings.set_string = () => false;
confirmation.handlers.response(confirmation, context.Gtk.ResponseType.ACCEPT);
assert.match(hidden.description, /could not be saved.*writable.*try again/i);
assert.equal(settings.registry, beforeReset);
assert.equal(visibleTasks(taskData, settings).today.length, 0);
assert.equal(confirmation.destroyed, undefined);
settings.set_string = successfulWrite;
confirmation.handlers.response(confirmation, context.Gtk.ResponseType.ACCEPT);
assert.equal(confirmation.destroyed, true);
assert.equal(hidden.description, '');
assert.deepEqual(readHidden(settings), []);
assert.equal(visibleTasks(taskData, settings).today.length, 1);
console.log('Unhide All failed write and retry passed');

const unscheduledBinding = bindings.find(([key]) => key === 'show-today-unscheduled');
assert(unscheduledBinding);
assert.equal(unscheduledBinding[1].title, "Show today's unscheduled tasks");
assert.match(xml, /<key name="show-today-unscheduled" type="b"><default>true<\/default>/);
const priorityBinding = bindings.find(([key]) => key === 'today-priority-a-first');
assert(priorityBinding);
assert.equal(priorityBinding[1].title, "Prioritize today's high priority tasks (#A)");
assert.equal(priorityBinding[1].subtitle, 'Show Priority A tasks first in Today, regardless of TODO or DOING status.');
assert.equal(priorityBinding[2], 'active');

// Exercise the actual preferences form and persistence boundary with a native-dialog double.
const chooserWindow = new Widget();
new context.Prefs().fillPreferencesWindow(chooserWindow);
const graphGroup = chooserWindow.children[0].children[0];
const [pathEntry, nameEntry, addGraphRow] = graphGroup.children;
const browse = pathEntry.children[0];
const beforeBrowsing = saved;
const openChooser = () => {
    browse.handlers.clicked();
    return choosers.at(-1);
};
const select = (dialog, path, basename = 'Selected graph') => {
    dialog.file = {get_path: () => path, get_basename: () => basename};
    dialog.handlers.response(dialog, context.Gtk.ResponseType.ACCEPT);
};
assert.equal(browse.label, 'Browse…');
let dialog = openChooser();
assert.equal(dialog.parent, chooserWindow);
assert.equal(dialog.action, context.Gtk.FileChooserAction.SELECT_FOLDER);
assert.equal(dialog.modal, true);
assert.equal(dialog.multiple, false);
assert.equal(dialog.createFolders, false);
assert.equal(dialog.shown, true);
assert.equal(browse.sensitive, false);
const count = choosers.length;
browse.handlers.clicked();
assert.equal(choosers.length, count);
const lateResponse = [...dialog.connections.values()][0].callback;
select(dialog, '/fixture/Personal notes é', 'Personal notes é');
assert.equal(pathEntry.text, '/fixture/Personal notes é');
assert.equal(nameEntry.text, 'Personal notes é');
assert.equal(saved, beforeBrowsing);
assert.equal(dialog.destroyCount, 1);
assert.equal(dialog.connections.size, 0);
assert.equal(browse.sensitive, true);

nameEntry.text = 'My alias';
dialog = openChooser();
lateResponse(choosers[choosers.length - 2], context.Gtk.ResponseType.ACCEPT);
assert.equal(dialog.destroyCount, undefined);
select(dialog, '/fixture/replacement');
assert.equal(pathEntry.text, '/fixture/replacement');
assert.equal(nameEntry.text, 'My alias');
dialog = openChooser();
select(dialog, '/fixture/again');
assert.equal(nameEntry.text, 'My alias');
nameEntry.text = '   ';
dialog = openChooser();
select(dialog, '/fixture/blank', 'Blank');
assert.equal(nameEntry.text, 'Blank');
// A previously generated name is editable and, once nonblank, preserved too.
dialog = openChooser();
select(dialog, '/fixture/next', 'Next');
assert.equal(nameEntry.text, 'Blank');

for (const response of [context.Gtk.ResponseType.CANCEL, context.Gtk.ResponseType.DELETE_EVENT]) {
    addGraphRow.subtitle = 'Previous feedback';
    dialog = openChooser();
    dialog.handlers.response(dialog, response);
    assert.equal(pathEntry.text, '/fixture/next');
    assert.equal(nameEntry.text, 'Blank');
    assert.equal(addGraphRow.subtitle, 'Previous feedback');
    assert.equal(dialog.destroyCount, 1);
}
for (const path of [null, 'relative']) {
    dialog = openChooser();
    select(dialog, path);
    assert.match(addGraphRow.subtitle, /local directory/);
    assert.equal(pathEntry.text, '/fixture/next');
    assert.equal(nameEntry.text, 'Blank');
}
dialog = openChooser();
dialog.handlers.response(dialog, context.Gtk.ResponseType.ACCEPT);
assert.match(addGraphRow.subtitle, /local directory/);
for (const failure of ['construct', 'show', 'get']) {
    chooserFailure = failure;
    dialog = openChooser();
    if (failure === 'get')
        select(dialog, '/should-not-apply');
    assert.match(addGraphRow.subtitle, /Could not (open|choose)/);
    assert.equal(browse.sensitive, true);
    assert.equal(pathEntry.text, '/fixture/next');
    if (failure !== 'construct') {
        assert.equal(dialog.destroyCount, 1);
        assert.equal(dialog.connections.size, 0);
    }
    chooserFailure = null;
    dialog = openChooser();
    dialog.handlers.response(dialog, context.Gtk.ResponseType.CANCEL);
    assert.equal(dialog.destroyCount, 1);
}
assert.equal(saved, beforeBrowsing);

// Selection still requires Add, including its original root and duplicate checks.
dialog = openChooser();
select(dialog, '/fixture/invalid');
roots = {};
addGraphRow.children[0].handlers.clicked();
assert.match(addGraphRow.subtitle, /non-symlink/);
assert.equal(saved, beforeBrowsing);
roots = {[graphRoots[0]]: 2};
nameEntry.text = '';
dialog = openChooser();
select(dialog, '/fixture/valid', 'Valid');
assert.equal(addGraphRow.subtitle, '');
addGraphRow.children[0].handlers.clicked();
assert.equal(saved, beforeBrowsing + 1);
assert.equal(JSON.stringify(settings.graphs), JSON.stringify([['/fixture/valid', 'Valid']]));
assert.equal(pathEntry.text, '');
assert.equal(nameEntry.text, '');
dialog = openChooser();
select(dialog, '/fixture/valid');
addGraphRow.children[0].handlers.clicked();
assert.match(addGraphRow.subtitle, /already configured/);
assert.equal(saved, beforeBrowsing + 1);
pathEntry.text = '/fixture/manual';
nameEntry.text = 'Manual name';
addGraphRow.children[0].handlers.clicked();
assert.equal(saved, beforeBrowsing + 2);
assert.equal(JSON.stringify(settings.graphs[1]), JSON.stringify(['/fixture/manual', 'Manual name']));
graphGroup.children.at(-1).children[0].handlers.clicked();
assert.equal(JSON.stringify(settings.graphs), JSON.stringify([['/fixture/valid', 'Valid']]));

for (const signal of ['close-request', 'unrealize']) {
    const closingWindow = new Widget();
    new context.Prefs().fillPreferencesWindow(closingWindow);
    const [closingPath, closingName] = closingWindow.children[0].children[0].children;
    const closingBrowse = closingPath.children[0];
    closingBrowse.handlers.clicked();
    const pending = choosers.at(-1);
    pending.file = {get_path: () => '/late', get_basename: () => 'Late'};
    const callback = [...pending.connections.values()][0].callback;
    const disconnectedBefore = settings.disconnections ?? 0;
    closingWindow.handlers[signal]();
    if (signal === 'close-request')
        assert.equal(settings.disconnections, disconnectedBefore + 1);
    assert.equal(pending.destroyCount, 1);
    assert.equal(pending.connections.size, 0);
    callback(pending, context.Gtk.ResponseType.ACCEPT);
    assert.equal(closingPath.text, '');
    assert.equal(closingName.text, '');
    closingWindow.handlers[signal]();
    assert.equal(pending.destroyCount, 1);
    const beforeReopen = choosers.length;
    closingBrowse.handlers.clicked();
    assert.equal(choosers.length, beforeReopen);
}
console.log('Graph folder chooser selection, validation, retry and lifecycle checks passed');
