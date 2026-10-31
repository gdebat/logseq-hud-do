import {displayContent, compileTextFilter, backendArguments, parseTasks, taskPresentation, RefreshController, sections} from '../extension/model.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}
function equal(actual, expected) {
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
const task = {content: '<b>Literal</b>', graph: 'Personal', source_page: 'Page', status: 'TODO', priority: null, scheduled: null, deep_link: 'logseq://graph/Personal?page=Page'};
equal(sections, ['today', 'overdue', 'upcoming']);
const data = {today: [task, {...task, status: 'DOING'}], overdue: [], upcoming: []};
equal(parseTasks(JSON.stringify(data)), data);
assert(taskPresentation(task).doing === false, 'TODO has no badge');
equal(taskPresentation(task).priority, null);
assert(taskPresentation({...task, status: 'DOING'}).doing, 'DOING badge');
for (const [priority, label, color] of [['A', 'High', 'high'], ['B', 'Medium', 'medium'], ['C', 'Low', 'low']])
    equal(taskPresentation({...task, priority}).priority, [label, color]);
equal(taskPresentation(task).content, '<b>Literal</b>');
equal(taskPresentation({...task, deep_link: 'https://example.com'}).uri, null);
equal(backendArguments('/extension', [['/a path/$(touch x)', 'Work']], 7).args,
    ['python3', '-m', 'logseq_hud_do', '--horizon', '7', '--graph=/a path/$(touch x)', '--graph-name=Work']);
for (const graphs of [[], [['relative', 'Invalid']]]) {
    let rejected = false;
    try { backendArguments('/extension', graphs, 7); } catch { rejected = true; }
    assert(rejected, 'invalid configuration refused');
}
for (const invalid of ['{}', '{"today":null}', JSON.stringify({...data, today: [{...task, status: 'DONE'}]})]) {
    let rejected = false;
    try { parseTasks(invalid); } catch { rejected = true; }
    assert(rejected, 'invalid response refused');
}
let calls = 0;
const pending = [];
const published = [];
const errors = [];
const controller = new RefreshController(() => {
    calls++;
    return new Promise((resolve, reject) => pending.push({resolve, reject}));
}, value => published.push(value), message => errors.push(message));
const first = controller.refresh();
controller.refresh(true);
controller.refresh();
equal(calls, 1);
pending.shift().resolve('obsolete');
await first;
equal(calls, 2);
equal(published, []);
pending.shift().resolve('fresh');
await Promise.resolve();
equal(published, ['fresh']);
const failure = controller.refresh();
pending.shift().reject(new Error('Missing graph'));
await failure;
equal(errors, ['Missing graph']);
const last = controller.refresh();
controller.close();
pending.shift().resolve('late');
await last;
await controller.refresh();
equal(published, ['fresh']);
equal(calls, 4);
print('Extension model and refresh tests passed');

for (const fails of [false, true]) {
    const queue = [];
    const results = [];
    const c = new RefreshController(() => new Promise((resolve, reject) => queue.push({resolve, reject})),
        x => results.push(x), x => results.push(x));
    for (let i = 0; i < 3; i++) {
        const running = c.refresh();
        c.refresh();
        c.refresh();
        if (fails) queue.shift().reject(new Error('visible'));
        else queue.shift().resolve('visible');
        await running;
    }
    equal(results, ['visible', 'visible', 'visible']);
    c.close();
    queue.shift().resolve('closed');
    await Promise.resolve();
    equal(results.length, 3);
}

for (const priority of ['A', 'B', 'C']) {
    const original = {...task, content: `[#${priority}] Ship [#A] now\nKeep literal <text>`, priority};
    equal(taskPresentation(original).content, 'Ship now\nKeep literal <text>');
    equal(taskPresentation(original).priority, {A: ['High', 'high'], B: ['Medium', 'medium'], C: ['Low', 'low']}[priority]);
    equal(original.content, `[#${priority}] Ship [#A] now\nKeep literal <text>`);
}
equal(taskPresentation({...task, content: '[#D] literal'}).content, '[#D] literal');

equal(displayContent('Task\n  relay-id:: abc\nKeep text\nrelay-id:: xyz'), 'Task\nKeep text');
equal(displayContent('Task\r\n\trelay-id:: abc\r\nKeep'), 'Task\nKeep');
equal(displayContent('relay-id:: abc', []), 'relay-id:: abc');
equal(displayContent('Keep relay-id:: literal\nrelay-id-other:: value'), 'Keep relay-id:: literal\nrelay-id-other:: value');
equal(displayContent('Task\nprivate:: value\nKeep', ['^private::']), 'Task\nKeep');
for (const pattern of ['[', '^(a+)+$', '^.*.*x', '^a?', '^a{2}', '^a|b', '^\\1', 'unanchored']) {
    let refused = false;
    try { compileTextFilter(pattern); } catch { refused = true; }
    assert(refused, `unsafe pattern accepted: ${pattern}`);
    equal(displayContent('Keep text', [pattern]), 'Keep text');
}
equal(displayContent('[#A] Task\nrelay-id:: abc'), 'Task');

for (const [scheduled, expected] of [[null, 'Personal'], ['2026-10-31', 'Personal · 31 Oct 2026'], ['2026-11-04', 'Personal · 4 Nov 2026']]) {
    const original = {...task, scheduled, journal_date: '2026-10-31', deadline: '2026-12-25',
        block_uuid: 'stored-block', block_location: {line: 42}};
    const snapshot = JSON.stringify(original);
    equal(taskPresentation(original).context, expected);
    equal(taskPresentation(original).uri, original.deep_link);
    equal(JSON.stringify(original), snapshot);
}
