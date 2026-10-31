import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
class Widget {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.handlers = {}; this.text = ''; }
    add(x) { this.children.push(x); }
    add_suffix(x) { this.add(x); }
    connect(signal, callback) { this.handlers[signal] = callback; }
}
const xml = fs.readFileSync('extension/schemas/org.gnome.shell.extensions.logseq-hud-do.gschema.xml', 'utf8');
const ranges = Object.fromEntries([...xml.matchAll(/<key name="([^"]+)"[^>]*>.*?<range min="(\d+)" max="(\d+)"/g)].map(m => [m[1], [+m[2], +m[3]]]));
const graphRoots = JSON.parse(process.argv[2] || '["pages","journals"]');
let roots = {};
const bindings = [];
let saved = 0;
const settings = {
    get_value: () => ({deep_unpack: () => []}),
    set_value: () => saved++,
    settings_schema: {get_key: key => ({get_range: () => ({deep_unpack: () => ['range', {deep_unpack: () => ranges[key]}]})})},
    bind: (key, row) => bindings.push([key, row]),
};
const context = vm.createContext({
    Adw: {PreferencesPage: Widget, PreferencesGroup: Widget, ActionRow: Widget, EntryRow: Widget, SpinRow: Widget, SwitchRow: Widget},
    Gtk: {Button: Widget, Adjustment: Widget, Align: {CENTER: 0}},
    GLib: {path_is_absolute: path => path.startsWith('/'), Variant: class {}},
    Gio: {SettingsBindFlags: {DEFAULT: 0}, FileQueryInfoFlags: {NOFOLLOW_SYMLINKS: 1}, FileType: {DIRECTORY: 2},
        File: {new_for_path: () => ({query_exists: () => true, get_child: name => ({query_file_type: flags => {assert.equal(flags, 1); return roots[name];}})})}},
    ExtensionPreferences: class {getSettings() {return settings;}},
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
for (const fixture of [...graphRoots.map(name => ({[name]: 3})), Object.fromEntries(graphRoots.map(name => [name, 3])), {}, {unsupported: 2}]) {
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
console.log('Preferences bounds and graph validation passed');
