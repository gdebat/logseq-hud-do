import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {defaultTextFilters, defaultBlockFilters, sections, taskPresentation, RefreshController, backendArguments, blockContextArguments, parseBlockContext, parseTasks, visibleTasks, hideTask} from '../extension/model.js';

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
const values = {'refresh-interval': 30, horizon: 7, 'show-today-unscheduled': true, 'show-overdue': true, 'show-upcoming': true, 'show-today-count': true};
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
    St, sections, taskPresentation, RefreshController, backendArguments, blockContextArguments, parseBlockContext, parseTasks, visibleTasks, hideTask,
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
assert.equal(hud._rows.children[0].text, 'Today — Unscheduled (2)');
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

assert(!hud._rows.children.some(child => child.text === 'Overdue (0)'));
const unscheduled = hud._data.today;
const scheduled = {...task, scheduled: '2026-11-01', content: 'Scheduled'};
const overdue = {...scheduled, scheduled: '2026-10-31'};
const upcoming = {...scheduled, scheduled: '2026-11-02'};
hud._data = {today: [unscheduled[0], scheduled, unscheduled[1]], overdue: [overdue], upcoming: [upcoming]};
const snapshot = JSON.stringify(hud._data);
const headings = () => hud._rows.children.filter(child => child.style_class === 'hud-heading').map(child => child.text);
const rendered = [];
const addTask = hud._addTask;
hud._addTask = task => rendered.push(task);
hud._render();
assert.deepEqual(headings(), ['Today (1)', 'Today — Unscheduled (2)', 'Overdue (1)', 'Upcoming (1)']);
assert.deepEqual(rendered, [scheduled, ...unscheduled, overdue, upcoming]);
assert.equal(hud._count.text, '3');
const savedRegistry = registry;
const savedTimers = [...timers.keys()];
const refresh = hud._controller.refresh;
hud._controller.refresh = () => assert.fail('Visibility changes must not refresh the backend');
for (const enabled of [false, true]) {
    rendered.length = 0;
    values['show-today-unscheduled'] = enabled;
    settings.handlers.changed(settings, 'show-today-unscheduled');
    assert.deepEqual(headings(), enabled
        ? ['Today (1)', 'Today — Unscheduled (2)', 'Overdue (1)', 'Upcoming (1)']
        : ['Today (1)', 'Overdue (1)', 'Upcoming (1)']);
    assert.deepEqual(rendered, enabled ? [scheduled, ...unscheduled, overdue, upcoming] : [scheduled, overdue, upcoming]);
    assert.equal(hud._count.text, enabled ? '3' : '1');
    assert.equal(registry, savedRegistry);
    assert.equal(JSON.stringify(hud._data), snapshot);
    assert.deepEqual([...timers.keys()], savedTimers);
}
hideTask(settings, unscheduled[0]);
const hiddenRegistry = registry;
for (const enabled of [true, false, true]) {
    rendered.length = 0;
    values['show-today-unscheduled'] = enabled;
    settings.handlers.changed(settings, 'show-today-unscheduled');
    assert.equal(hud._count.text, enabled ? '2' : '1');
    assert.deepEqual(headings(), enabled
        ? ['Today (1)', 'Today — Unscheduled (1)', 'Overdue (1)', 'Upcoming (1)']
        : ['Today (1)', 'Overdue (1)', 'Upcoming (1)']);
    assert.deepEqual(rendered, enabled ? [scheduled, unscheduled[1], overdue, upcoming] : [scheduled, overdue, upcoming]);
    assert.equal(registry, hiddenRegistry);
    assert.equal(JSON.stringify(hud._data), snapshot);
    assert.deepEqual([...timers.keys()], savedTimers);
}
settings.set_string('hidden-tasks-v2', savedRegistry);
hud._controller.refresh = refresh;
// Overdue and Upcoming visibility does not contribute to the Today counter.
for (const enabled of [false, true]) {
    values['show-today-unscheduled'] = enabled;
    for (const showOverdue of [false, true]) {
        for (const showUpcoming of [false, true]) {
            values['show-overdue'] = showOverdue;
            values['show-upcoming'] = showUpcoming;
            rendered.length = 0;
            hud._render();
            assert.equal(hud._count.text, enabled ? '3' : '1');
            assert.deepEqual(rendered, [scheduled, ...(enabled ? unscheduled : []),
                ...(showOverdue ? [overdue] : []), ...(showUpcoming ? [upcoming] : [])]);
        }
    }
}
hud._data = {today: [], overdue: [], upcoming: []};
hud._render();
assert.equal(hud._rows.children.length, 0);
assert.equal(hud._count.text, '0');
hud._addTask = addTask;
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

for (const raw of ['{', 'null', '{}', '[]', '{"version":99,"tasks":[]}',
    '{"version":2,"tasks":null}', '{"version":2,"tasks":[null,{},42]}',
    JSON.stringify({version: 2, tasks: [{key: JSON.stringify(['/Graph', 'Page', task.content, null])}]})]) {
    registry = raw;
    const safe = new context.Hud();
    safe._runBackend = hiding._runBackend;
    safe.enable();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(safe._count.text, '2');
    safe._confirmHide(task);
    safe._dialog.buttons[1].action();
    if (raw === '{' || !Array.isArray(JSON.parse(raw)?.tasks) || JSON.parse(raw).version !== 2) {
        assert.equal(registry, raw);
        assert.match(safe._message.label.text, /No changes were saved/);
        assert.equal(safe._count.text, '2');
    } else {
        assert.equal(safe._count.text, '0');
        for (const entry of JSON.parse(raw).tasks)
            assert(JSON.parse(registry).tasks.some(value => JSON.stringify(value) === JSON.stringify(entry)));
    }
    safe.disable();
}
registry = '{"version":2,"tasks":[]}';
hideTask(settings, task);
const validRegistry = JSON.parse(registry);
validRegistry.tasks.push(null, {}, {key: validRegistry.tasks[0].key});
registry = JSON.stringify(validRegistry);
const mixedHud = new context.Hud();
mixedHud._runBackend = hiding._runBackend;
mixedHud.enable();
await new Promise(resolve => setImmediate(resolve));
assert.equal(mixedHud._count.text, '0');
mixedHud.disable();

registry = '{"version":2,"tasks":[]}';
const rejectedHud = new context.Hud();
rejectedHud._runBackend = hiding._runBackend;
rejectedHud.enable();
await new Promise(resolve => setImmediate(resolve));
rejectedHud._confirmHide(task);
const pendingDialog = rejectedHud._dialog;
const workingWrite = settings.set_string;
settings.set_string = () => false;
pendingDialog.buttons[1].action();
assert.equal(rejectedHud._dialog, pendingDialog);
assert.equal(rejectedHud._count.text, '2');
assert.match(pendingDialog.contentLayout.children[0].description, /could not be saved/i);
settings.set_string = workingWrite;
// The registry can change while confirmation is pending.
hideTask(settings, task);
const updated = JSON.parse(registry);
updated.tasks[0].future = {keep: true};
registry = JSON.stringify(updated);
pendingDialog.buttons[1].action();
assert.equal(JSON.parse(registry).tasks[0].future.keep, true);
assert.equal(rejectedHud._dialog, null);
rejectedHud.disable();

// --- Block context hover popup ---------------------------------------------
// Augment the doubles with the actor/layout/timer surface the popup needs.
const popupTimers = new Map();
let popupTimerId = 1000;
context.GLib.timeout_add = (_priority, interval, callback) => {
    const id = ++popupTimerId;
    popupTimers.set(id, {interval, callback: () => {
        const keep = callback();
        if (keep === context.GLib.SOURCE_REMOVE)
            popupTimers.delete(id);
        return keep;
    }});
    return id;
};
context.GLib.SOURCE_REMOVE = false;
context.GLib.PRIORITY_DEFAULT = 0;
const originalSourceRemove = context.GLib.Source.remove;
context.GLib.Source.remove = id => { popupTimers.delete(id); return originalSourceRemove(id); };

const uiGroup = new St.BoxLayout();
context.Main.layoutManager = {
    uiGroup,
    primaryMonitor: {x: 0, y: 0, width: 1920, height: 1080},
};
// Extents/preferred-size helpers for positioning.
St.Button.prototype.get_transformed_extents = function () {
    return {
        get_origin: () => ({x: this._x ?? 100, y: this._y ?? 50}),
        get_size: () => ({width: 16, height: 16}),
    };
};
Actor.prototype.get_preferred_width = function () { return [0, this._prefWidth ?? 200]; };
Actor.prototype.get_preferred_height = function () { return [0, this._prefHeight ?? 120]; };
Actor.prototype.set_position = function (x, y) { this._posX = x; this._posY = y; };

let cancelFlag = false;
context.Gio.Cancellable = class { cancel() { cancelFlag = true; } is_cancelled() { return cancelFlag; } };

settings.get_value = key => ({deep_unpack: () => key === 'task-block-filters' ? [...defaultBlockFilters, ['BEGIN', 'END']] : [['/fixture', 'Fixture']]});
const popupHud = new context.Hud();
popupHud.path = '/extension';
popupHud._runBackend = async () => ({today: [], overdue: [], upcoming: []});
popupHud.enable();
await new Promise(resolve => setImmediate(resolve));

const ctxTask = {...task, graph_path: '/fixture', graph: 'Fixture', source_file: 'pages/project.md', id: 'abc123'};
popupHud._data = {today: [ctxTask], overdue: [], upcoming: []};
popupHud._render();
const containers = popupHud._rows.children.filter(child => child.children?.some(c => c.accessible_name === 'Preview block context'));
assert.equal(containers.length, 1, 'a Preview button is added per task row');
const previewButton = containers[0].children.find(c => c.accessible_name === 'Preview block context');
assert(previewButton, 'preview button present beside hide');

// Entering starts a debounce timeout; no process spawned yet.
const spawnBaseline = completions.length;
cancelFlag = false;
previewButton.handlers['enter-event']();
assert.equal(popupTimers.size, 1, 'enter-event arms one debounce timer');
assert.equal(completions.length, spawnBaseline, 'no backend spawn before debounce elapses');

// Leaving before the debounce cancels it.
previewButton.handlers['leave-event']();
assert.equal(popupTimers.size, 0, 'leave-event cancels the pending debounce');
assert.equal(completions.length, spawnBaseline, 'cancelled debounce never spawns the backend');

// Enter, let the debounce fire -> spawn the one-shot backend command.
previewButton.handlers['enter-event']();
const [ppTimerId, ppTimer] = [...popupTimers.entries()][0];
assert.equal(ppTimer.interval, 300, 'debounce is 300ms');
ppTimer.callback();
assert(!popupTimers.has(ppTimerId), 'debounce is one-shot');
assert(spawned.includes('--block-context'), 'spawns the block-context command');
assert(spawned.includes('pages/project.md') && spawned.includes('abc123'));

// Backend replies with a context payload; popup renders on uiGroup.
completions.shift()({stdout: JSON.stringify({
    graph: 'Fixture', graph_path: '/fixture', source_file: 'pages/project.md',
    parent: [{content: 'Project Alpha', uuid: null, block_location: {line: 1}}],
    current: {content: 'TODO Ship the thing', uuid: 'u', block_location: {line: 3}},
    children: [{content: 'TODO sub one', uuid: null, block_location: {line: 4}},
        {content: 'DOING sub two', uuid: null, block_location: {line: 5}}],
}), stderr: ''});
await new Promise(resolve => setImmediate(resolve));
assert(popupHud._popup, 'popup created');
assert(uiGroup.children.includes(popupHud._popup), 'popup appended to uiGroup');
const labels = popupHud._popup.children;
assert.equal(labels[0].text, '• Project Alpha');
assert.equal(labels[0].style_class, 'hud-preview-parent');
assert.equal(labels[0].opacity, 150, 'parent is muted via actor opacity, not CSS');
assert.equal(labels[1].text, '• TODO Ship the thing');
assert.equal(labels[1].style_class, 'hud-preview-current');
assert.equal(labels[2].text, '• TODO sub one');
assert.equal(labels[2].style_class, 'hud-preview-child');
assert.equal(labels[3].text, '• DOING sub two');

// Positioned below the button and within the monitor.
assert.equal(popupHud._popup._posX, 100);
assert.equal(popupHud._popup._posY, 50 + 16 + 4);

// Leaving dismisses the popup and cancels the (already-finished) request.
previewButton.handlers['leave-event']();
assert.equal(popupHud._popup, null, 'leave hides the popup');
assert(popupHud._popup === null);

// Off-screen clamping: a button near the right/bottom edges is pulled back in.
previewButton._x = 1900; previewButton._y = 1070;
cancelFlag = false;
previewButton.handlers['enter-event']();
[...popupTimers.values()][0].callback();
completions.shift()({stdout: JSON.stringify({
    graph: 'Fixture', graph_path: '/fixture', source_file: 'pages/project.md',
    parent: [], current: {content: 'Edge', uuid: null, block_location: {line: 1}}, children: [],
}), stderr: ''});
await new Promise(resolve => setImmediate(resolve));
assert(popupHud._popup._posX + 200 <= 1920, 'clamped within right edge');
assert(popupHud._popup._posY + 120 <= 1080, 'flips above when it would overflow the bottom');
previewButton.handlers['leave-event']();

// Backend failure renders the error text instead of crashing.
previewButton._x = 100; previewButton._y = 50;
cancelFlag = false;
previewButton.handlers['enter-event']();
[...popupTimers.values()][0].callback();
popupHud._popupProcess.success = false;
completions.shift()({stdout: '', stderr: '{"error":"block not found: abc123"}', success: false});
await new Promise(resolve => setImmediate(resolve));
assert(popupHud._popup, 'error popup created');
assert.equal(popupHud._popup.children[0].text, 'block not found: abc123');
previewButton.handlers['leave-event']();

// Disable cleans up any shown popup.
cancelFlag = false;
previewButton.handlers['enter-event']();
[...popupTimers.values()][0].callback();
completions.shift()({stdout: JSON.stringify({
    graph: 'Fixture', graph_path: '/fixture', source_file: 'pages/project.md',
    parent: [], current: {content: 'Edge', uuid: null, block_location: {line: 1}}, children: [],
}), stderr: ''});
await new Promise(resolve => setImmediate(resolve));
assert(popupHud._popup, 'popup present before disable');
popupHud.disable();
assert.equal(popupHud._popup, null, 'disable tears down the popup');
console.log('Block context popup tests passed');
