import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {defaultTextFilters, defaultBlockFilters, sections, taskPresentation, RefreshController, backendArguments, parseTasks, visibleTasks, hideTask} from '../extension/model.js';

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
let registry = '{"version":2,"tasks":[]}';
settings.get_string = () => registry;
settings.set_string = (_key, value) => { registry = value; settings.handlers.changed?.(settings, 'hidden-tasks-v2'); };
settings.get_strv = () => defaultTextFilters;
settings.get_boolean = key => values[key];
settings.get_int = key => values[key];
settings.get_value = key => ({deep_unpack: () => key === 'task-block-filters' ? [...defaultBlockFilters, ['BEGIN', 'END']] : []});
const timers = new Map();
let timerId = 0;
const now = {add_days: () => now, get_year: () => 2026, get_month: () => 11, get_day_of_month: () => 1, difference: () => 10000000};
const St = {BoxLayout: Actor, Icon: Actor, Label: Actor, ScrollView: Actor, Button: class extends Actor {}, PolicyType: {NEVER: 0, AUTOMATIC: 1}};
const context = vm.createContext({
    St, sections, taskPresentation, RefreshController, backendArguments, parseTasks, visibleTasks, hideTask,
    Extension: class { getSettings() { return settings; } },
    Clutter: {KEY_Escape: 65307, ActorAlign: {CENTER: 0}}, Pango: {EllipsizeMode: {NONE: 0}},
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
assert.equal(hud._indicator.menu.children[1].reactive, true);
assert.equal(hud._indicator.menu.children[1].track_hover, false);
assert.equal(hud._indicator.menu.children[1].hover, false);
assert.equal(hud._indicator.menu.children[1].activate, false);
const task = {content: '<literal>\nBEGIN\nhidden\nEND', graph: 'Graph', graph_path: '/Graph', source_page: 'Page', scheduled: null, priority: null, status: 'TODO', deep_link: 'logseq://graph/Graph?page=Page'};
hud._data = {today: [task, {...task, content: 'Second', status: 'DOING', priority: 'A'}], overdue: [], upcoming: []};
hud._render();
assert.equal(hud._rows.children[0].text, 'TODAY (2)');
const buttons = hud._rows.children.flatMap(child => child.children).filter(child => child instanceof St.Button && child.style_class === "hud-task");
assert.equal(buttons[0].children[0].children.length, 2);
assert.equal(buttons[0].children[0].children[0].text, '<literal>');
assert.equal(buttons[0].children[0].children[0].style_class, undefined);
assert.equal(buttons[0].children[0].children.at(-1).style_class, 'hud-context');
assert.equal(buttons[0].children[0].children.at(-1).opacity, 170);
assert.equal(buttons[1].children[0].children[1].children[0].text, 'High');
assert.equal(buttons[1].children[0].children[1].children[1].text, 'Doing');
buttons[0].handlers.clicked();
assert.match(hud._message.label.text, /Install Logseq/);
let launched;
let closed = false;
const launchContext = {};
context.global = {create_app_launch_context: (timestamp, workspace) => {
    assert.equal(timestamp, 0);
    assert.equal(workspace, -1);
    return launchContext;
}};
context.Gio.AppInfo.get_default_for_uri_scheme = scheme => {
    assert.equal(scheme, 'logseq');
    return {};
};
context.Gio.AppInfo.launch_default_for_uri_async = (uri, suppliedContext, cancellable, callback) => {
    launched = [uri];
    assert.equal(suppliedContext, launchContext);
    callback(null, {});
};
context.Gio.AppInfo.launch_default_for_uri_finish = () => true;
hud._indicator.menu.close = () => { closed = true; };
buttons[0].handlers.clicked();
assert.deepEqual(launched, [task.deep_link]);
assert(closed);
context.Gio.AppInfo.launch_default_for_uri_finish = () => { throw new Error('Launch failed'); };
buttons[0].handlers.clicked();
assert.match(hud._message.label.text, /Launch failed/);
hud._addTask({...task, deep_link: null});
hud._rows.children.at(-1).children[0].handlers.clicked();
assert.match(hud._message.label.text, /No Logseq link/);

assert.equal(hud._rows.children[3].text, 'OVERDUE (0)');
const metadataTasks = [
    {...task, scheduled: '2026-10-31'},
    {...task, graph: 'Personal', source_page: 'Oct 31st, 2026', scheduled: null,
        journal_date: '2026-10-31', source_file: 'journals/2026_10_31.md'},
    {...task, scheduled: '2026-10-30', deep_link: 'logseq://graph/Graph?block-id=stored-block',
        block_uuid: 'stored-block', block_location: {line: 42}},
    {...task, scheduled: '2026-11-04'},
].map((task, index) => ({...task, deadline: index === 1 ? null : '2026-12-25'}));
const metadataSnapshot = JSON.stringify(metadataTasks);
hud._data = {today: metadataTasks.slice(0, 2), overdue: [metadataTasks[2]], upcoming: [metadataTasks[3]]};
hud._render();
const metadataButtons = hud._rows.children.flatMap(child => child.children).filter(child => child instanceof St.Button && child.style_class === "hud-task");
context.Gio.AppInfo.launch_default_for_uri_finish = () => true;
for (const [index, expected] of ['Graph · 31 Oct 2026', 'Personal', 'Graph · 30 Oct 2026', 'Graph · 4 Nov 2026'].entries()) {
    const button = metadataButtons[index];
    const metadata = button.children[0].children.at(-1);
    assert.equal(metadata.text, expected);
    assert.equal(metadata.style_class, 'hud-context');
    assert.equal(metadata.opacity, 170);
    assert(!button.accessible_name.includes(metadataTasks[index].source_page));
    button.handlers.clicked();
    assert.deepEqual(launched, [metadataTasks[index].deep_link]);
}
assert.equal(JSON.stringify(metadataTasks), metadataSnapshot);
hud._data = {today: [task, {...task, status: 'DOING', priority: 'A'}], overdue: [], upcoming: []};
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
settings.get_value = key => ({deep_unpack: () => key === 'task-block-filters' ? [...defaultBlockFilters, ['BEGIN', 'END']] : [['/fixture', 'Fixture']]});
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
assert.equal(integrated._rows.children[1].children[0].children[0].children[0].text, '<literal>');
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

for (const staleError of [false, true]) {
    values.horizon = 7;
    settings.get_value = key => ({deep_unpack: () => key === 'task-block-filters' ? [...defaultBlockFilters, ['BEGIN', 'END']] : [['/fixture', 'Fixture']]});
    const changing = new context.Hud();
    changing.path = '/extension';
    changing.enable();
    const initialTimer = changing._timer;
    values.horizon = 14;
    settings.get_value = key => ({deep_unpack: () => key === 'task-block-filters' ? [...defaultBlockFilters, ['BEGIN', 'END']] : [['/updated', 'Updated']]});
    settings.handlers.changed();
    settings.handlers.changed();
    assert.equal(completions.length, 1);
    assert(!timers.has(initialTimer));
    assert.equal(timers.size, 2);
    completions.shift()(staleError
        ? {error: 'Obsolete failure'}
        : {stdout: JSON.stringify({today: [task], overdue: [], upcoming: []}), stderr: ''});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(changing._data, undefined);
    assert.equal(changing._rows.children.length, 0);
    assert.equal(changing._message.label.text, 'Loading tasks…');
    assert.equal(completions.length, 1);
    assert(spawned.includes('--graph=/updated'));
    assert.equal(spawned[spawned.indexOf('--horizon') + 1], '14');
    completions.shift()({stdout: JSON.stringify({today: [{...task, content: 'Updated result'}], overdue: [], upcoming: []}), stderr: ''});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(changing._rows.children[1].children[0].children[0].children[0].text, 'Updated result');
    changing._controller.refresh();
    settings.handlers.changed();
    let terminated = false;
    let cancelledActive = false;
    changing._process.force_exit = () => { terminated = true; };
    changing._cancellable.cancel = () => { cancelledActive = true; };
    const rows = changing._rows;
    changing.disable();
    assert(terminated && cancelledActive);
    completions.shift()({error: 'Cancelled'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completions.length, 0);
    assert.equal(rows.children[1].children[0].children[0].children[0].text, 'Updated result');
    assert.equal(timers.size, 0);
    assert.equal(Object.keys(settings.handlers).length, 0);
    assert.equal(changing._controller.pending, false);
}

class NativeDialog extends Actor {
    constructor() { super(); this.contentLayout = new Actor(); }
    setButtons(buttons) { this.buttons = buttons; }
    open() { this.opened = true; }
    close() { this.handlers.closed(); }
}
context.ModalDialog = {ModalDialog: NativeDialog};
context.Dialog = {MessageDialogContent: Actor};
const hiding = new context.Hud();
hiding._runBackend = async () => ({today: [task, {...task}], overdue: [], upcoming: []});
hiding.enable();
await new Promise(resolve => setImmediate(resolve));
hiding._confirmHide(task);
assert.equal(hiding._dialog.contentLayout.children[0].description, task.content);
assert.equal(hiding._dialog.buttons[0].default, true);
assert.equal(hiding._dialog.buttons[0].key, context.Clutter.KEY_Escape);
hiding._dialog.buttons[0].action();
assert.equal(hiding._count.text, '2');
hiding._confirmHide(task);
let hideScans = 0;
const originalRun = hiding._controller.run;
hiding._controller.run = () => { hideScans++; return originalRun(); };
hiding._dialog.buttons[1].action();
assert.equal(hideScans, 0);
assert.equal(hiding._count.text, '0');
await hiding._controller.refresh();
assert.equal(hiding._count.text, '0');
hiding.disable();
const restarted = new context.Hud();
restarted._runBackend = hiding._runBackend;
restarted.enable();
await new Promise(resolve => setImmediate(resolve));
assert.equal(restarted._count.text, '0');
settings.set_string('hidden-tasks-v2', '{"version":2,"tasks":[]}');
assert.equal(restarted._count.text, '2');
restarted.disable();
