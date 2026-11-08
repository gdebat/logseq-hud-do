import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {defaultTextFilters, defaultBlockFilters, sections, taskPresentation, RefreshController, backendArguments, blockContextArguments, parseBlockContext, parseTasks, visibleTasks, hideTask, sortTodayTasks} from '../extension/model.js';

class Actor {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.clutter_text = {}; this.handlers = {}; }
    add_child(child) { this.children.push(child); child.parent = this; }
    set_child(child) { this.contentChild = child; this.children = [child]; }
    get_child() { return this.contentChild; }
    get_children() { return this.children; }
    set_policy(horizontal, vertical) { this.policies = [horizontal, vertical]; }
    set_style(style) { this.style = style; }
    connect(name, callback) { this.handlers[name] = callback; return name; }
    disconnect(name) { delete this.handlers[name]; }
    destroy_all_children() { for (const child of [...this.children]) child.destroy?.(); this.children = []; }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.handlers.destroy?.();
        this.destroy_all_children();
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    }
    contains(actor) { return actor === this || this.children.some(child => child.contains?.(actor)); }
    grab_key_focus() { this.focused = true; }
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
const values = {'refresh-interval': 30, horizon: 7, 'today-priority-a-first': true, 'show-today-unscheduled': true, 'show-overdue': true, 'show-upcoming': true, 'show-today-count': true};
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
const St = {BoxLayout: Actor, Widget: Actor, Icon: Actor, Label: Actor, ScrollView: Actor, Button: class extends Actor {}, PolicyType: {NEVER: 0, AUTOMATIC: 1}};
const context = vm.createContext({
    St, sections, taskPresentation, RefreshController, backendArguments, blockContextArguments, parseBlockContext, parseTasks, visibleTasks, hideTask, sortTodayTasks,
    Extension: class { getSettings() { return settings; } },
    Clutter: {KEY_Escape: 65307, ActorAlign: {CENTER: 0}}, Pango: {EllipsizeMode: {NONE: 0}, WrapMode: {WORD_CHAR: 2}},
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

// --- Section separators (#9) -----------------------------------------------
// While _addTask is stubbed, _rows holds only headings and separators, so the
// structure can be asserted directly. Separators sit strictly between adjacent
// populated sections: one fewer than the number of sections.
const classesOf = () => hud._rows.children.map(child => child.style_class);
const isSep = cls => cls === 'hud-separator';
{
    const classes = classesOf();
    const headingCount = classes.filter(c => c === 'hud-heading').length;
    const sepCount = classes.filter(isSep).length;
    assert.equal(headingCount, 4);
    assert.equal(sepCount, 3, 'one separator between each of four sections');
    // Never first or last.
    assert(!isSep(classes[0]), 'no orphaned separator at the top');
    assert(!isSep(classes[classes.length - 1]), 'no trailing separator');
    // Never two in a row, and every separator is flanked by headings.
    for (let i = 0; i < classes.length; i++) {
        if (isSep(classes[i])) {
            assert(!isSep(classes[i - 1]) && !isSep(classes[i + 1]), 'no consecutive separators');
            assert.equal(classes[i - 1], 'hud-heading');
            assert.equal(classes[i + 1], 'hud-heading');
        }
    }
}
// A gap in the middle (empty section) must not double or orphan separators.
hud._data = {today: [scheduled], overdue: [], upcoming: [upcoming]};
hud._render();
assert.deepEqual(classesOf(), ['hud-heading', 'hud-separator', 'hud-heading'],
    'two populated sections -> single separator between them');
// A single populated section has no separators at all.
hud._data = {today: [scheduled], overdue: [], upcoming: []};
hud._render();
assert.equal(classesOf().filter(isSep).length, 0, 'single section has no separators');
assert(!isSep(classesOf()[0]), 'single section does not start with a separator');
// Disabled (not merely empty) sections are also skipped without stray separators.
hud._data = {today: [scheduled], overdue: [overdue], upcoming: [upcoming]};
values['show-overdue'] = false;
hud._render();
assert.deepEqual(classesOf(), ['hud-heading', 'hud-separator', 'hud-heading'],
    'a disabled middle section yields exactly one separator between the two shown');
values['show-overdue'] = true;
// Restore the four-section fixture for the assertions that follow.
hud._data = {today: [unscheduled[0], scheduled, unscheduled[1]], overdue: [overdue], upcoming: [upcoming]};
hud._render();
assert.deepEqual(headings(), ['Today (1)', 'Today — Unscheduled (2)', 'Overdue (1)', 'Upcoming (1)']);
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
// Priority A promotion is confined to scheduled Today and uses loaded data.
const doingB = {...scheduled, content: 'Doing B', status: 'DOING', priority: 'B'};
const todoA = {...scheduled, content: 'Todo A', priority: 'A'};
const unscheduledA = {...unscheduled[0], content: 'Unscheduled A', priority: 'A'};
const otherSections = [
    {...overdue, status: 'DOING', priority: 'B'}, {...overdue, content: 'Overdue A', priority: 'A'},
    {...upcoming, status: 'DOING', priority: 'B'}, {...upcoming, content: 'Upcoming A', priority: 'A'},
];
const priorityData = {today: [doingB, unscheduled[0], todoA, unscheduledA],
    overdue: otherSections.slice(0, 2), upcoming: otherSections.slice(2)};
hud._data = priorityData;
values['show-today-unscheduled'] = true;
const prioritySnapshot = JSON.stringify(priorityData);
const priorityTimers = [...timers.keys()];
hud._controller.refresh = () => assert.fail('Priority ordering must not scan');
for (const enabled of [false, true, false, true]) {
    values['today-priority-a-first'] = enabled;
    rendered.length = 0;
    settings.handlers.changed(settings, 'today-priority-a-first');
    assert.deepEqual(rendered, [...(enabled ? [todoA, doingB] : [doingB, todoA]),
        unscheduled[0], unscheduledA, ...otherSections]);
    assert.equal(hud._count.text, '4');
    assert.equal(JSON.stringify(hud._data), prioritySnapshot);
    assert.deepEqual([...timers.keys()], priorityTimers);
}
hideTask(settings, todoA);
for (const enabled of [false, true]) {
    values['today-priority-a-first'] = enabled;
    rendered.length = 0;
    settings.handlers.changed(settings, 'today-priority-a-first');
    assert.deepEqual(rendered, [doingB, unscheduled[0], unscheduledA, ...otherSections]);
    assert.equal(hud._count.text, '3');
}
settings.set_string('hidden-tasks-v2', savedRegistry);
hud._controller.refresh = refresh;
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
const popupTimers = new Map();
let popupTimerId = 1000;
context.GLib.timeout_add = (_priority, interval, callback) => {
    const id = ++popupTimerId;
    popupTimers.set(id, {interval, callback: () => {
        const keep = callback();
        if (keep === context.GLib.SOURCE_REMOVE) popupTimers.delete(id);
        return keep;
    }});
    return id;
};
context.GLib.SOURCE_REMOVE = false;
context.GLib.PRIORITY_DEFAULT = 0;
const originalSourceRemove = context.GLib.Source.remove;
context.GLib.Source.remove = id => { popupTimers.delete(id); return originalSourceRemove(id); };
function fireTimer(interval) {
    const timer = [...popupTimers.values()].find(t => t.interval === interval);
    assert(timer, `expected ${interval}ms timer`);
    timer.callback();
}
const stage = new Actor();
stage.get_key_focus = () => stage.focus;
stage.set_key_focus = actor => { stage.focus = actor; stage.handlers['notify::key-focus']?.(); };
stage.get_event_actor = event => event.actor;
context.global.stage = stage;
context.Clutter.EventType = {KEY_PRESS: 1, BUTTON_PRESS: 2, BUTTON_RELEASE: 3, MOTION: 4, SCROLL: 5};
Object.assign(context.Clutter, {KEY_Return: 65293, KEY_KP_Enter: 65421, KEY_space: 32});
context.Clutter.EVENT_STOP = true;
context.Clutter.EVENT_PROPAGATE = false;
context.Shell = {ActionMode: {POPUP: 1}};
const grabs = new Set();
context.Main.pushModal = actor => { const grab = {actor}; grabs.add(grab); stage.set_key_focus(actor); return grab; };
context.Main.popModal = grab => { assert(grabs.delete(grab), 'balanced modal grab'); };
const uiGroup = new St.BoxLayout();
let area = {x: 0, y: 24, width: 1920, height: 1056};
context.Main.layoutManager = {
    uiGroup,
    primaryMonitor: {index: 0, x: 0, y: 0, width: 1920, height: 1080},
    findMonitorForActor: () => null,
    getWorkAreaForMonitor: () => area,
};
let scale = 1;
St.ThemeContext = {get_for_stage: () => ({scale_factor: scale})};
St.Button.prototype.get_transformed_extents = function () {
    return {get_x: () => this._x ?? 100, get_y: () => this._y ?? 50,
        get_width: () => 16, get_height: () => 16};
};
Actor.prototype.get_preferred_width = function () { return [0, this._prefWidth ?? 200]; };
Actor.prototype.get_preferred_height = function () { return [0, this._prefHeight ?? 120]; };
Actor.prototype.set_position = function (x, y) { this._posX = x; this._posY = y; };
Actor.prototype.set_width = function (width) { this.width = width; };
Actor.prototype.set_height = function (height) { this.height = height; };
context.Gio.Cancellable = class { cancel() { this.cancelled = true; } is_cancelled() { return !!this.cancelled; } };
let popupSpawns = 0;
let launchFailure = false;
const processes = [];
context.Gio.SubprocessLauncher = class {
    set_cwd(directory) { assert.equal(directory, '/extension'); }
    setenv() {}
    spawnv(args) {
        if (launchFailure) throw new Error('python3 unavailable');
        popupSpawns++;
        assert(args.includes('--block-context'));
        const process = {
            killed: false,
            force_exit() { this.killed = true; },
            communicate_utf8_async(_input, cancellable, callback) { this.cancellable = cancellable; this.complete = r => callback(this, r); },
            communicate_utf8_finish(r) { if (r.error) throw new Error(r.error); this.success = r.success !== false; return [true, r.stdout, r.stderr ?? '']; },
            get_successful() { return this.success; },
        };
        processes.push(process);
        return process;
    }
};
const payload = {parent: [{content: 'Parent\nparent continuation', uuid: null}],
    current: {content: 'TODO first\n<b>literal continuation</b> ' + 'long'.repeat(100), uuid: null},
    children: [{content: 'Child\nchild continuation', uuid: null}]};
function reply(process = processes.at(-1), value = payload) { process.complete({stdout: JSON.stringify(value)}); }
function allPopupLabels() { return popupHud._popup.children[0].children[0].children[0].children.flatMap(row => row.children).filter(child => typeof child.text === 'string'); }
function popupLabels() { return allPopupLabels().filter(label => label.style_class !== 'hud-preview-page'); }
function leave(button = previewButton) { button.hover = false; button.handlers['leave-event'](); }
function enter(button = previewButton) { button.hover = true; button.handlers['enter-event'](); }
function escape() {
    return stage.handlers['captured-event'](stage, {type: () => context.Clutter.EventType.KEY_PRESS,
        get_key_symbol: () => context.Clutter.KEY_Escape});
}
settings.get_value = key => ({deep_unpack: () => key === 'task-block-filters' ? [...defaultBlockFilters] : [['/fixture', 'Fixture']]});
const popupHud = new context.Hud();
popupHud.path = '/extension';
popupHud._runBackend = async () => ({today: [], overdue: [], upcoming: []});
popupHud.enable();
await new Promise(resolve => setImmediate(resolve));
const ctxTask = {...task, graph_path: '/fixture', graph: 'Fixture', source_file: 'pages/project.md', id: 'abc123'};
popupHud._data = {today: [ctxTask], overdue: [], upcoming: []};
popupHud._render();
let previewButton = popupHud._rows.children[1].children.find(c => c.accessible_name === 'Preview block context');
const hideButton = popupHud._rows.children[1].children.find(c => c.accessible_name === 'Hide task');
assert.equal(previewButton.child.icon_name, 'view-more-symbolic');
assert.equal(hideButton.child.icon_name, 'view-conceal-symbolic');
assert.equal(previewButton.child.icon_size, hideButton.child.icon_size);
assert.equal(previewButton.track_hover, true);

// Debounce and cancellation, including crossing into the button's child icon.
enter();
previewButton.handlers['leave-event'](); // Still hovered: internal crossing.
assert.equal(popupTimers.size, 1);
enter();
assert.equal(popupTimers.size, 1, 're-entry must not duplicate the timer');
assert.equal(popupSpawns, 0);
leave();
assert.equal(popupTimers.size, 0);
assert.equal(popupHud._preview, null);
assert.equal(Object.keys(stage.handlers).length, 0);
enter(); fireTimer(300);
assert.equal(popupSpawns, 1);
assert.equal(popupTimers.size, 0);
const pending = processes.at(-1);
leave();
assert(pending.killed && pending.cancellable.is_cancelled());
reply(pending); // A queued success after cancellation must never render.
assert.equal(popupHud._popup, null);

// Complete content, hierarchy, literal text, native surface, bounded scrolling.
enter(); fireTimer(300); reply();
const box = popupHud._popup;
assert(uiGroup.children.includes(box));
assert(box.style_class.includes('popup-menu'));
assert(box.children[0].style_class.includes('popup-menu-content'));
assert.equal(box.children[0].children[0].overlay_scrollbars, false);
assert.deepEqual(box.children[0].children[0].policies, [St.PolicyType.NEVER, St.PolicyType.AUTOMATIC]);
assert(!/background-color|(?:^|[;{])\s*color:/.test(fs.readFileSync('extension/stylesheet.css', 'utf8').match(/\.hud-preview \{([^}]+)\}/)[1]));
const labels = popupLabels();
assert.equal(labels[0].text, '• ' + payload.parent[0].content);
assert.equal(labels[0].opacity, 190);
assert.equal(labels[1].text, '↳ ' + payload.current.content);
assert.equal(labels[1].style_class, 'hud-preview-current');
assert.equal(labels[2].text, '↳ ' + payload.children[0].content);
assert.equal(labels[2].style_class, 'hud-preview-child');
assert.equal(labels[1].clutter_text.line_wrap_mode, context.Pango.WrapMode.WORD_CHAR);
assert.equal(labels[1].use_markup, undefined);
assert.equal(box._posY, 70);
assert.equal(grabs.size, 1, 'popup can receive input outside the panel menu grab');
const spawnCount = popupSpawns;
leave();
assert(popupTimers.size === 1 && popupHud._popup === box, 'gap crossing keeps popup alive');
box.hover = true; box.handlers['enter-event']();
assert.equal(popupTimers.size, 0);
box.hover = false; box.handlers['leave-event']();
enter();
assert.equal(popupTimers.size, 0);
assert.equal(popupSpawns, spawnCount, 'button/popup re-entry reuses the response');
leave(); fireTimer(180);
assert.equal(popupHud._popup, null);
assert(box.destroyed);
assert.equal(grabs.size, 0);

// A scrollbar click is allowed through; outside clicks dismiss the preview.
enter(); fireTimer(300); reply();
const scrollActor = popupHud._popup.children[0].children[0];
stage.handlers['captured-event'](stage, {type: () => context.Clutter.EventType.BUTTON_PRESS, actor: scrollActor});
assert(popupHud._popup, 'scrollbar interaction must not dismiss the popup');
popupHud._indicator.menu.actor = new Actor();
let menuClosed = false;
popupHud._indicator.menu.close = () => { menuClosed = true; };
stage.handlers['captured-event'](stage, {type: () => context.Clutter.EventType.BUTTON_PRESS, actor: new Actor()});
assert(menuClosed);
assert.equal(popupHud._popup, null);
assert.equal(grabs.size, 0);
assert.equal(uiGroup.children.length, 0);

// Bounds: oversized content, offset monitors, work area, scaling, above/beside.
function within(box) {
    assert(box.width > 0 && box.height > 0);
    assert(box._posX >= area.x && box._posY >= area.y);
    assert(box._posX + box.width <= area.x + area.width);
    assert(box._posY + box.height <= area.y + area.height);
}
for (const geometry of [
    {x: 1900, y: 1040, width: 200, height: 120},
    {x: 100, y: 400, width: 200, height: 2000},
    {x: 200, y: 400, width: 4000, height: 2000},
]) {
    const b = new Actor({_prefWidth: geometry.width, _prefHeight: geometry.height});
    previewButton._x = geometry.x; previewButton._y = geometry.y;
    popupHud._positionPopup(previewButton, b); within(b);
    if (geometry.y === 1040) assert(b._posY < geometry.y, 'flips above');
    if (geometry.x === 100) assert(b._posX > geometry.x, 'uses space beside button');
}
area = {x: -1280, y: 100, width: 1280, height: 720}; scale = 2;
context.Main.layoutManager.findMonitorForActor = () => ({index: 1});
context.Main.layoutManager.getWorkAreaForMonitor = index => { assert.equal(index, 1); return area; };
previewButton._x = -20; previewButton._y = 790;
const huge = new Actor({_prefWidth: 5000, _prefHeight: 10000});
popupHud._positionPopup(previewButton, huge); within(huge);
area = {x: 0, y: 24, width: 1920, height: 1056}; scale = 1;
context.Main.layoutManager.findMonitorForActor = () => null;
context.Main.layoutManager.getWorkAreaForMonitor = () => area;
previewButton._x = 100; previewButton._y = 50;

// Backend errors and synchronous setup/launch failures use the same safe layout.
enter(); fireTimer(300);
processes.at(-1).complete({stdout: '', stderr: '{"error":"block missing"}', success: false});
assert.equal(popupLabels()[0].text, '• block missing'); within(popupHud._popup);
leave(); fireTimer(180);
launchFailure = true;
enter(); assert.doesNotThrow(() => fireTimer(300));
assert.equal(popupLabels()[0].text, '• python3 unavailable');
assert.equal(popupHud._popupProcess, null);
leave(); fireTimer(180); launchFailure = false;

// Keyboard activation bypasses debounce; Escape consumes only the preview.
stage.set_key_focus(previewButton);
previewButton.handlers.clicked();
assert.equal(popupTimers.size, 0);
reply();
leave();
assert(popupHud._popup, 'keyboard preview stays open without pointer hover');
assert.equal(escape(), true);
assert.equal(popupHud._popup, null);
assert(previewButton.focused);
assert.equal(Object.keys(stage.handlers).length, 0);
// Clicking while the hover debounce is pending starts only one query.
enter(); const beforeClick = popupSpawns;
previewButton.handlers.clicked(); reply();
assert.equal(popupSpawns, beforeClick + 1);
assert.equal(popupTimers.size, 0);
leave(); stage.set_key_focus(new Actor()); fireTimer(180);
assert.equal(popupHud._popup, null, 'moving keyboard focus away dismisses popup');

// Switching tasks and refresh invalidates late callbacks, and destroy cancels timers.
enter(); fireTimer(300); const old = processes.at(-1);
const other = new St.Button(); popupHud._bindPreview(other, {...ctxTask, id: 'other'});
enter(other); assert(old.killed);
fireTimer(300); const current = processes.at(-1);
reply(old); assert.equal(popupHud._popup, null);
reply(current); assert(popupHud._popup);
previewButton.handlers.destroy();
assert(popupHud._popup, 'destroying an unrelated row must not close the active popup');
other.destroy(); assert.equal(popupHud._popup, null);
// Refresh destroys the actual source row, including a pending debounce.
enter();
popupHud._render();
assert.equal(popupTimers.size, 0);
previewButton = popupHud._rows.children[1].children.find(c => c.accessible_name === 'Preview block context');
enter(); fireTimer(300); const refreshProcess = processes.at(-1);
popupHud._render(); reply(refreshProcess);
assert(refreshProcess.killed);
assert.equal(popupHud._popup, null);
previewButton = popupHud._rows.children[1].children.find(c => c.accessible_name === 'Preview block context');

// A positioning exception removes every actor/grab and reports a controlled error.
enter(); fireTimer(300);
const savedExtents = previewButton.get_transformed_extents;
previewButton.get_transformed_extents = () => { throw new Error('no allocation'); };
assert.doesNotThrow(() => reply());
assert.equal(popupHud._popup, null);
assert.equal(uiGroup.children.length, 0);
assert.equal(grabs.size, 0);
assert.match(popupHud._message.label.text, /no allocation/);
previewButton.get_transformed_extents = savedExtents;

// Closing the menu and disabling during work clear processes, sources and signals.
enter(); fireTimer(300); reply();
popupHud._indicator.menu.handlers['open-state-changed'](null, false);
assert.equal(popupHud._popup, null);
enter(); fireTimer(300); const disableProcess = processes.at(-1);
popupHud.disable(); reply(disableProcess);
assert(disableProcess.killed && disableProcess.cancellable.is_cancelled());
assert.equal(popupTimers.size, 0);
assert.equal(Object.keys(stage.handlers).length, 0);
assert.equal(uiGroup.children.length, 0);
assert.equal(grabs.size, 0);

// Disable while the debounce or rendered popup exists as well as during I/O.
for (const rendered of [false, true]) {
    const instance = new context.Hud();
    instance.path = '/extension';
    instance._runBackend = async () => ({today: [], overdue: [], upcoming: []});
    instance.enable();
    await new Promise(resolve => setImmediate(resolve));
    const anchor = new St.Button();
    instance._bindPreview(anchor, ctxTask);
    anchor.hover = true;
    anchor.handlers['enter-event']();
    if (rendered) { fireTimer(300); reply(); }
    instance.disable();
    assert.equal(instance._popup, null);
    assert.equal(popupTimers.size, 0);
    assert.equal(Object.keys(stage.handlers).length, 0);
    assert.equal(grabs.size, 0);
    assert.equal(uiGroup.children.length, 0);
}
console.log('Block context popup regressions passed');

// Page header and hierarchy matrix, preserving the existing popup lifecycle.
for (const [parentCount, childCount] of [[0, 0], [2, 0], [0, 2], [3, 2]]) {
    const instance = new context.Hud();
    instance.path = '/extension';
    instance._runBackend = async () => ({today: [], overdue: [], upcoming: []});
    instance.enable();
    await new Promise(resolve => setImmediate(resolve));
    const anchor = new St.Button();
    const page = '<Project> ' + 'Long page name '.repeat(30);
    instance._bindPreview(anchor, {...ctxTask, source_page: page});
    enter(anchor); fireTimer(300);
    const hierarchy = {
        parent: Array.from({length: parentCount}, (_, i) => ({content: `Ancestor ${i}\nmore`, uuid: null})),
        current: {content: 'TODO Selected\nmultiline', uuid: null},
        children: Array.from({length: childCount}, (_, i) => ({content: `Child ${i}\nmore`, uuid: null})),
    };
    reply(processes.at(-1), hierarchy);
    const content = instance._popup.children[0].children[0].children[0];
    const header = content.children[0].children[0];
    assert.equal(header.text, '📄 ' + page);
    assert.equal(header.style_class, 'hud-preview-page');
    assert.equal(content.children[0].style, 'padding-left: 0px;', 'page header stays unindented');
    assert.equal(header.clutter_text.line_wrap, true);
    assert.equal(header.use_markup, undefined);
    assert(content.children[1].style_class.includes('popup-separator-menu-item'));
    assert.equal(content.children[1].children[0].style_class, 'popup-separator-menu-item-separator');
    const rows = content.children.slice(2);
    const blocks = [...hierarchy.parent, hierarchy.current, ...hierarchy.children];
    assert.equal(rows.length, blocks.length);
    rows.forEach((row, i) => {
        const label = row.children[0];
        assert.equal(label.text, `${i === 0 ? '•' : '↳'} ${blocks[i].content}`);
        const depth = i < parentCount ? i : i === parentCount ? parentCount : parentCount + 1;
        assert.equal(row.style, `padding-left: ${depth * 12}px;`);
        assert.equal(label.clutter_text.line_wrap, true);
        if (i < parentCount) {
            assert.equal(label.style_class, 'hud-preview-parent');
            assert.equal(label.opacity, 190);
        } else if (i === parentCount) {
            assert.equal(label.style_class, 'hud-preview-current');
        } else {
            assert.equal(label.style_class, 'hud-preview-child');
        }
    });
    const css = fs.readFileSync('extension/stylesheet.css', 'utf8');
    assert.match(css, /\.hud-preview-current\s*\{[^}]*font-weight:\s*bold/);
    assert.match(css, /\.hud-preview-page\s*\{[^}]*font-weight:\s*bold/);
    instance.disable();
    assert.equal(grabs.size, 0);
    assert.equal(popupTimers.size, 0);
    assert.equal(uiGroup.children.length, 0);
}
console.log('Page header and hierarchy matrix passed');

// Popup activation shares the task row's navigation helper and exact URI.
const navigationCalls = [], navigationCompletions = [];
context.Gio.AppInfo.get_default_for_uri_scheme = () => ({});
context.Gio.AppInfo.launch_default_for_uri_async = (uri, _launch, _cancel, callback) => {
    navigationCalls.push(uri);
    navigationCompletions.push(result => callback(null, result));
};
context.Gio.AppInfo.launch_default_for_uri_finish = result => {
    if (result.error) throw new Error(result.error);
};
function popupEvent(type, actor, {button = 1, x = 20, y = 20, key = 0} = {}) {
    return {type: () => type, actor, get_button: () => button,
        get_coords: () => [x, y], get_key_symbol: () => key};
}
function sendPopup(box, event) {
    const stageResult = stage.handlers['captured-event']?.(stage, event);
    return stageResult === context.Clutter.EVENT_STOP ? stageResult : box.handlers['captured-event'](box, event);
}
for (const [sourceFile, page, uri] of [
    ['pages/project.md', 'Project Planning', 'logseq://graph/Graph?page=Project%20Planning'],
    ['journals/2026_11_06.md', '2026-11-06, Fri', 'logseq://graph/Graph?page=2026-11-06%2C%20Fri'],
    ['pages/project.md', 'Project Planning', 'logseq://graph/Graph?block-id=12345678-1234-1234-1234-123456789abc'],
]) {
    const instance = new context.Hud(); instance.path = '/extension';
    instance._runBackend = async () => ({today: [], overdue: [], upcoming: []});
    instance.enable(); await new Promise(resolve => setImmediate(resolve));
    let hideActions = 0;
    instance._confirmHide = () => hideActions++;
    instance._data = {today: [{...ctxTask, source_file: sourceFile, source_page: page, deep_link: uri}], overdue: [], upcoming: []};
    instance._render();
    const [entry, preview, hide] = instance._rows.children[1].children;
    const before = navigationCalls.length;
    entry.handlers.clicked();
    assert.deepEqual(navigationCalls.slice(before), [uri]);
    navigationCompletions.shift()({});
    hide.handlers.clicked(); assert.equal(hideActions, 1);
    assert.equal(navigationCalls.length, before + 1);
    function openPopup(keyboard = false) {
        const count = navigationCalls.length;
        if (keyboard) preview.handlers.clicked();
        else { enter(preview); fireTimer(300); }
        reply();
        assert.equal(navigationCalls.length, count, 'Preview only opens context');
        return instance._popup;
    }
    function dismissed(box, process, count) {
        assert.equal(navigationCalls.length, count + 1, 'one navigation per activation');
        assert.equal(navigationCalls.at(-1), uri);
        assert.equal(instance._popup, null);
        assert.equal(instance._preview, null);
        assert.equal(instance._popupProcess, null);
        assert.equal(instance._popupCancellable, null);
        assert(process.cancellable.is_cancelled());
        assert(box.destroyed);
        assert.equal(grabs.size, 0);
        assert.equal(popupTimers.size, 0);
        assert.equal(Object.keys(stage.handlers).length, 0);
        assert.equal(hideActions, 1, 'popup never triggers Hide');
    }
    // Capture works across every displayed region and both padding containers.
    for (const region of ['header', 'ancestor', 'selected', 'child', 'separator', 'surface', 'outer']) {
        const box = openPopup();
        const content = box.children[0].children[0].children[0];
        const targets = {header: content.children[0].children[0], ancestor: content.children[2].children[0],
            selected: content.children[3].children[0], child: content.children[4].children[0],
            separator: content.children[1].children[0], surface: box.children[0], outer: box};
        const actor = targets[region], count = navigationCalls.length, process = processes.at(-1);
        instance._queuePopupClose(); // Activation must also remove a pending close timeout.
        sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, actor));
        assert.equal(navigationCalls.length, count, 'press alone does not navigate');
        assert.equal(sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, actor)), true);
        dismissed(box, process, count);
        sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, actor));
        assert.equal(navigationCalls.length, count + 1, 'late/bubbled release cannot navigate twice');
        navigationCompletions.shift()({});
    }
    for (const key of [context.Clutter.KEY_Return, context.Clutter.KEY_space, context.Clutter.KEY_KP_Enter]) {
        const box = openPopup(true), count = navigationCalls.length, process = processes.at(-1);
        assert.equal(box.can_focus, true);
        assert.equal(stage.focus, box, 'keyboard preview gives focus to the activatable popup');
        sendPopup(box, popupEvent(context.Clutter.EventType.KEY_PRESS, box, {key}));
        dismissed(box, process, count);
        navigationCompletions.shift()({});
    }
    let box = openPopup(true), count = navigationCalls.length;
    assert.equal(sendPopup(box, popupEvent(context.Clutter.EventType.KEY_PRESS, box, {key: context.Clutter.KEY_Escape})), true);
    assert.equal(instance._popup, null);
    assert.equal(navigationCalls.length, count, 'Escape dismisses without navigation');

    // Wheel input, other buttons, and thumb drags keep the popup available.
    box = openPopup(); count = navigationCalls.length;
    const scroll = box.children[0].children[0];
    // St.ScrollView's internal scrollbar actors are siblings of get_child(),
    // not descendants of the scrollable content (on Shell 46 and 50).
    const track = new Actor(), thumb = new Actor(), thumbChild = new Actor();
    thumb.add_child(thumbChild); track.add_child(thumb); scroll.add_child(track);
    const horizontalTrack = new Actor();
    scroll.children.unshift(horizontalTrack); // Internal controls can precede content.
    for (const control of [horizontalTrack, track, thumb, thumbChild]) {
        assert.equal(sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, control)), false);
        assert.equal(sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, control)), false);
        assert.equal(navigationCalls.length, count, 'stationary scrollbar clicks must not navigate');
        assert.equal(instance._popup, box);
    }
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, thumb));
    sendPopup(box, popupEvent(context.Clutter.EventType.MOTION, thumb, {y: 70}));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, thumb, {y: 70}));
    // Crossing between a scrollbar and content cannot complete a content click.
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, thumb));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, box));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, box));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, thumb));
    assert.equal(navigationCalls.length, count);
    assert.equal(sendPopup(box, popupEvent(context.Clutter.EventType.SCROLL, scroll)), false);
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, box));
    sendPopup(box, popupEvent(context.Clutter.EventType.SCROLL, scroll));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, box));
    assert.equal(navigationCalls.length, count, 'scrolling cancels a pending content click');
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, scroll, {button: 3}));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, scroll, {button: 3}));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, scroll));
    sendPopup(box, popupEvent(context.Clutter.EventType.MOTION, scroll, {y: 70}));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, scroll));
    assert.equal(navigationCalls.length, count);
    assert.equal(instance._popup, box);
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, box));
    box.hover = false; box.handlers['leave-event']();
    box.hover = true; box.handlers['enter-event']();
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, box));
    assert.equal(navigationCalls.length, count, 'leaving cancels a pending click');
    // Content remains clickable with both scrollbar siblings present.
    const textActor = scroll.get_child().children[2].children[0];
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_PRESS, textActor));
    sendPopup(box, popupEvent(context.Clutter.EventType.BUTTON_RELEASE, textActor));
    dismissed(box, processes.at(-1), count);
    navigationCompletions.shift()({});
    count = navigationCalls.length;
    // Refresh and disable leave old activation callbacks inert.
    instance._render();
    sendPopup(box, popupEvent(context.Clutter.EventType.KEY_PRESS, box, {key: context.Clutter.KEY_Return}));
    assert.equal(navigationCalls.length, count);
    instance.disable();
    assert.equal(grabs.size, 0);
    assert.equal(popupTimers.size, 0);
    assert.equal(uiGroup.children.length, 0);
}
assert.match(fs.readFileSync('extension/stylesheet.css', 'utf8'),
    /\.hud-preview:hover \.hud-preview-page, \.hud-preview:focus \.hud-preview-page\s*\{[^}]*text-decoration:\s*underline/);
console.log('Shared popup navigation, click/keyboard activation, scrolling and cleanup passed');

// Real scan titles and block-context CLI responses from sanitized fixtures.
if (process.argv[2]) {
    const previews = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const requests = [];
    context.Gio.SubprocessLauncher = class {
        set_cwd() {}
        setenv() {}
        spawnv(args) {
            const process = {
                force_exit() {},
                communicate_utf8_async(_input, _cancel, callback) { this.complete = result => callback(this, result); },
                communicate_utf8_finish(result) { return [true, result.stdout, '']; },
                get_successful() { return true; },
            };
            requests.push({args: Array.from(args), process});
            return process;
        }
    };
    for (const {task: selected, context: hierarchy} of previews) {
        const instance = new context.Hud();
        instance.path = '/extension';
        instance._runBackend = async () => ({today: [], overdue: [], upcoming: []});
        instance.enable(); await new Promise(resolve => setImmediate(resolve));
        const anchor = new St.Button();
        instance._bindPreview(anchor, selected);
        enter(anchor); fireTimer(300);
        const request = requests.shift();
        assert(request.args.includes(`--graph=${selected.graph_path}`));
        assert(request.args.includes(selected.source_file));
        assert(request.args.includes(selected.id));
        request.process.complete({stdout: JSON.stringify(hierarchy)});
        const content = instance._popup.children[0].children[0].children[0];
        assert.equal(content.children[0].children[0].text, '📄 ' + selected.source_page);
        const rows = content.children.slice(2);
        const blocks = [...hierarchy.parent, hierarchy.current, ...hierarchy.children];
        assert.equal(rows.length, blocks.length);
        rows.forEach((row, i) => {
            const label = row.children[0];
            assert.equal(label.text, `${i ? '↳' : '•'} ${blocks[i].content}`);
            const depth = i <= hierarchy.parent.length ? i : hierarchy.parent.length + 1;
            assert.equal(row.style, `padding-left: ${depth * 12}px;`);
            assert.equal(label.clutter_text.line_wrap, true);
        });
        assert.equal(rows[hierarchy.parent.length].children[0].style_class, 'hud-preview-current');
        assert.equal(rows[0].children[0].opacity, 190);
        instance.disable();
    }
    const regularPages = previews.filter(({task}) => task.source_file.startsWith('pages/'));
    assert.equal(regularPages[0].task.source_page, regularPages[1].task.source_page);
    assert.notEqual(regularPages[0].task.graph_path, regularPages[1].task.graph_path);
    const journals = previews.filter(({task}) => task.source_file.startsWith('journals/'));
    assert.notEqual(journals[0].task.source_page, journals[1].task.source_page);
    assert.equal(grabs.size, 0);
    assert.equal(uiGroup.children.length, 0);
    console.log('Real CLI ancestor chains and page titles reach the popup intact');
}
