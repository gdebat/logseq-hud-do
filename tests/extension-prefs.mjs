import {compileTextFilter, defaultTextFilters, defaultBlockFilters, readHidden, writeHidden, unhideTask} from '../extension/model.js';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
class Widget {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.handlers = {}; this.text = ''; }
    remove(x) { this.children.splice(this.children.indexOf(x), 1); }
    add(x) { this.children.push(x); }
    add_suffix(x) { this.add(x); }
    connect(signal, callback) { this.handlers[signal] = callback; }
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
    connect: (_signal, callback) => { settings.onHidden = callback; return 1; }, disconnect() {},
    get_strv: () => defaultTextFilters,
    set_strv: (key, patterns) => { assert.equal(key, 'task-text-filters'); settings.patterns = patterns; },
    get_value: key => ({deep_unpack: () => key === 'task-block-filters' ? defaultBlockFilters : []}),
    set_value: (key, value) => { if (key === 'task-block-filters') settings.blocks = value.value; else saved++; },
    settings_schema: {get_key: key => ({get_range: () => ({deep_unpack: () => ['range', {deep_unpack: () => ranges[key]}]})})},
    bind: (key, row) => bindings.push([key, row]),
};
const context = vm.createContext({
    TextDecoder, compileTextFilter, readHidden, writeHidden, unhideTask,
    Adw: {PreferencesPage: Widget, PreferencesGroup: Widget, ActionRow: Widget, EntryRow: Widget, SpinRow: Widget, SwitchRow: Widget},
    Gtk: {MessageDialog: Widget, ButtonsType: {NONE: 0}, ResponseType: {CANCEL: 0, ACCEPT: 1}, SearchEntry: Widget, Button: Widget, Adjustment: Widget, Align: {CENTER: 0}},
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
Widget.prototype.destroy = function () {};
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
