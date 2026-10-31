import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {sections, taskPresentation, RefreshController, backendArguments, parseTasks} from '../extension/model.js';

class Actor {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.clutter_text = {}; this.handlers = {}; }
    add_child(child) { this.children.push(child); }
    set_child(child) { this.children = [child]; }
    set_policy() {}
    connect(name, callback) { this.handlers[name] = callback; return name; }
    disconnect(name) { delete this.handlers[name]; }
    destroy_all_children() { this.children = []; }
    destroy() { this.destroyed = true; }
    hide() { this.hidden = true; }
    show() { this.hidden = false; }
}
class Menu extends Actor {
    addMenuItem(item) { this.add_child(item); }
    addAction(label, action) { this.add_child({label, action}); }
    close() {}
}
class Indicator extends Actor { constructor() { super(); this.menu = new Menu(); } }
class Item extends Actor { constructor(text) { super(); this.label = new Actor({text}); } }
const values = {'refresh-interval': 30, horizon: 7, 'show-overdue': true, 'show-upcoming': true, 'show-today-count': true};
const settings = new Actor();
settings.get_boolean = key => values[key];
settings.get_int = key => values[key];
settings.get_value = () => ({deep_unpack: () => []});
const timers = new Map();
let timerId = 0;
const now = {add_days: () => now, get_year: () => 2026, get_month: () => 11, get_day_of_month: () => 1, difference: () => 10000000};
const St = {BoxLayout: Actor, Icon: Actor, Label: Actor, ScrollView: Actor, Button: class extends Actor {}, PolicyType: {NEVER: 0, AUTOMATIC: 1}};
const context = vm.createContext({
    St, sections, taskPresentation, RefreshController, backendArguments, parseTasks,
    Extension: class { getSettings() { return settings; } },
    Clutter: {ActorAlign: {CENTER: 0}}, Pango: {EllipsizeMode: {NONE: 0}},
    PanelMenu: {Button: Indicator},
    PopupMenu: {PopupMenuItem: Item, PopupBaseMenuItem: Actor, PopupSeparatorMenuItem: Actor},
    Main: {panel: {addToStatusArea() {}}},
    GLib: {DateTime: {new_now_local: () => now, new_local: () => now},
        timeout_add_seconds: (_priority, seconds, callback) => { const id = ++timerId; timers.set(id, {seconds, callback}); return id; },
        Source: {remove: id => timers.delete(id)}},
    Gio: {AppInfo: {get_default_for_uri_scheme: () => null}},
});
let source = fs.readFileSync('extension/extension.js', 'utf8').replace(/^import .*;\n/gm, '');
source = source.replace('export default class LogseqHudDo', 'globalThis.Hud = class LogseqHudDo');
vm.runInContext(source, context);
const hud = new context.Hud();
hud._runBackend = async () => ({today: [], overdue: [], upcoming: []});
hud.enable();
await Promise.resolve();
assert.equal(hud._indicator.children[0].children[0].icon_name, 'checkbox-checked-symbolic');
assert.equal(hud._count.text, '0');
assert.equal(timers.size, 2);
const task = {content: '<literal>', graph: 'Graph', source_page: 'Page', scheduled: null, priority: null, status: 'TODO', deep_link: 'logseq://graph/Graph?page=Page'};
hud._data = {today: [task, {...task, content: 'Second', status: 'DOING', priority: 'A'}], overdue: [], upcoming: []};
hud._render();
assert.equal(hud._rows.children[0].text, 'TODAY (2)');
const buttons = hud._rows.children.filter(child => child instanceof St.Button);
assert.equal(buttons[0].children[0].children.length, 2);
assert.equal(buttons[0].children[0].children[0].text, '<literal>');
assert.equal(buttons[1].children[0].children[1].children[0].text, '◴ DOING');
assert.equal(buttons[1].children[0].children[1].children[1].text, 'High');
buttons[0].handlers.clicked();
assert.match(hud._message.label.text, /Install Logseq/);
assert.equal(hud._rows.children[3].text, 'OVERDUE (0)');
values['show-overdue'] = false;
values['show-today-count'] = false;
hud._render();
assert.equal(hud._count.text, '');
assert(!hud._rows.children.some(child => child.text === 'OVERDUE (0)'));
let refreshes = 0;
hud._controller.refresh = () => refreshes++;
hud._indicator.menu.handlers['open-state-changed'](null, true);
hud._indicator.menu.children.find(child => child.label === 'Refresh').action();
assert.equal(refreshes, 2);
timers.get(hud._timer).callback();
assert.equal(refreshes, 3);
let killed = false;
let cancelled = false;
hud._process = {force_exit() { killed = true; }};
hud._cancellable = {cancel() { cancelled = true; }};
const indicator = hud._indicator;
hud.disable();
assert(killed && cancelled && indicator.destroyed);
assert.equal(timers.size, 0);
assert.equal(Object.keys(settings.handlers).length, 0);
assert(hud._controller.closed);
console.log('Extension UI and cleanup tests passed');

context.Clutter.Orientation = {VERTICAL: 1};
for (const modern of [false, true]) {
    if (modern) Actor.prototype.orientation = 0;
    const box = hud._verticalBox();
    assert.equal(modern ? box.orientation : box.vertical, modern ? 1 : true);
    delete Actor.prototype.orientation;
}
settings.get_value = () => ({deep_unpack: () => [['/fixture', 'Fixture']]});
context.Clutter.Orientation = {VERTICAL: 1};
const completions = [];
let spawned;
Object.assign(context.Gio, {
    SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2},
    Cancellable: class { cancel() {} },
    SubprocessLauncher: class {
        set_cwd(value) { assert.equal(value, '/extension'); }
        setenv(key, value, overwrite) { assert.equal(key, 'PYTHONPATH'); assert.equal(value, '/extension'); assert(overwrite); }
        spawnv(args) {
            spawned = Array.from(args);
            return {
                communicate_utf8_async(_input, _cancel, callback) { completions.push(result => callback(this, result)); },
                communicate_utf8_finish(result) { if (result.error) throw new Error(result.error); return [true, result.stdout, result.stderr]; },
                get_successful() { return this.success; },
                success: true,
            };
        }
    },
});
values['show-today-count'] = true;
const integrated = new context.Hud();
integrated.path = '/extension';
integrated.enable();
assert(spawned.includes('--graph=/fixture'));
completions.shift()({stdout: JSON.stringify({today: [task], overdue: [], upcoming: []}), stderr: ''});
await new Promise(resolve => setImmediate(resolve));
assert.equal(integrated._count.text, '1');
assert.equal(integrated._rows.children[1].children[0].children[0].text, '<literal>');
for (const result of [
    {stdout: '', stderr: '{"error":"Scan failed"}', success: false, expected: 'Scan failed'},
    {stdout: '{', stderr: '', success: true, expected: /JSON|position|property/},
    {error: 'Communication failed', expected: 'Communication failed'},
]) {
    const running = integrated._controller.refresh();
    integrated._process.success = result.success;
    completions.shift()(result);
    await running;
    assert.match(integrated._message.label.text, new RegExp(result.expected));
    assert.equal(integrated._rows.children.length, 0);
}
const before = completions.length;
timers.get(integrated._timer).callback();
assert.equal(completions.length, before + 1);
completions.shift()({stdout: '{"today":[],"overdue":[],"upcoming":[]}', stderr: ''});
await new Promise(resolve => setImmediate(resolve));
integrated.disable();
assert.equal(timers.size, 0);
