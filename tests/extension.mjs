import {displayContent, compileTextFilter, backendArguments, parseTasks, taskPresentation, RefreshController, sections, logicalIdentity, hideTask, visibleTasks, readHidden, writeHidden, unhideTask} from '../extension/model.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}
function equal(actual, expected) {
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
const task = {content: '<b>Literal</b>', graph: 'Personal', graph_path: '/graphs/personal', source_page: 'Page', status: 'TODO', priority: null, scheduled: null, deep_link: 'logseq://graph/Personal?page=Page'};
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

for (const [content, expected] of [
    ['Before\n:LOGBOOK:\nclock data\nmore data\n:END:\nAfter', 'Before\nAfter'],
    ['Before\r\n \t:LOGBOOK: \r\nhidden\r\n :END: \t\r\nAfter', 'Before\nAfter'],
    [':LOGBOOK:\none\n:END:\nMiddle\n:LOGBOOK:\ntwo\n:END:', 'Middle'],
    ['Before\n:LOGBOOK:\n:END:\nAfter', 'Before\nAfter'],
    ['Before\n:LOGBOOK:\nunfinished\nAfter', 'Before\n:LOGBOOK:\nunfinished\nAfter'],
    ['Before\n:END:\nAfter', 'Before\n:END:\nAfter'],
    [':LOGBOOK:\n:LOGBOOK:\nhidden\n:END:\nvisible\n:END:', 'visible\n:END:'],
    [':LOGBOOK:\nhidden\n:END:\nKeep\n:LOGBOOK:\nunfinished', 'Keep\n:LOGBOOK:\nunfinished'],
    ['Inline :LOGBOOK:\nKeep\n:END: suffix', 'Inline :LOGBOOK:\nKeep\n:END: suffix'],
]) {
    const original = {...task, content};
    equal(taskPresentation(original).content, expected);
    equal(original.content, content);
}
equal(displayContent('Keep\nBEGIN.*\nhidden\nEND+\nAfter', [], [['BEGIN.*', 'END+']]), 'Keep\nAfter');
equal(displayContent(':LOGBOOK:\nKeep\n:END:', [], []), ':LOGBOOK:\nKeep\n:END:');
equal(displayContent('Keep\nrelay-id:: value\n:LOGBOOK:\nhidden\n:END:', []), 'Keep\nrelay-id:: value');
equal(displayContent('Keep\nBEGIN\nhidden\nEND\nrelay-id:: value', undefined, [['BEGIN', 'END']]), 'Keep');
equal(displayContent('Keep', [], [['', 'END'], ['BEGIN', ' ']]), 'Keep');
equal(displayContent('A\nBEGIN\nx\nEND\nB', [], [['BEGIN', 'END'], ['BEGIN', 'OTHER']]), 'A\nB');

const identity = logicalIdentity(task);
for (const change of [
    {status: 'DOING'}, {priority: 'A'}, {content: '  [#A] <b>Literal</b>  '},
    {block_uuid: 'different', id: 'different', block_location: {line: 999}}, {graph: 'Renamed alias'},
]) equal(logicalIdentity({...task, ...change}), identity);
for (const change of [
    {content: '<b>literal</b>'}, {content: '<b>Literal!</b>'}, {content: 'Changed'}, {content: 'TODO <b>Literal</b>'},
    {scheduled: '2026-11-01'}, {source_page: 'Other'}, {graph_path: '/graphs/other'},
]) assert(logicalIdentity({...task, ...change}) !== identity, 'logical identity changes');
equal(logicalIdentity({...task, content: 'One \t two\nThree'}),
    logicalIdentity({...task, content: 'One two\nThree'}));
assert(logicalIdentity({...task, content: 'One\nTwo'}) !== logicalIdentity({...task, content: 'One Two'}), 'multiline preserved');
const journal = {...task, source_page: 'Nov 1st, 2026', journal_date: '2026-11-01'};
equal(logicalIdentity(journal), logicalIdentity({...journal, source_file: 'journals/renamed.md'}));
let saved = '{"version":2,"tasks":[]}';
const settings = {get_string: () => saved, set_string: (_key, value) => { saved = value; }};
hideTask(settings, task);
hideTask(settings, {...task, status: 'DOING'});
equal(readHidden(settings).length, 1);
const duplicates = {today: [task, {...task, status: 'DOING'}, {...task, scheduled: '2026-11-02'}], overdue: [], upcoming: []};
equal(visibleTasks(duplicates, settings).today.length, 1);
writeHidden(settings, []);
let release;
const hiddenController = new RefreshController(() => new Promise(resolve => { release = resolve; }),
    data => equal(visibleTasks(data, settings).today.length, 1), message => { throw Error(message); });
const refresh = hiddenController.refresh();
hideTask(settings, task);
release(duplicates);
await refresh;
writeHidden(settings, []);
equal(visibleTasks(duplicates, settings).today.length, 3);

for (const raw of ['{', 'null', '{}', '[]', '{"version":99,"tasks":[{"future":true}]}', '{"version":2,"tasks":null}']) {
    for (const action of [() => hideTask(settings, task), () => unhideTask(settings, identity)]) {
        saved = raw;
        let refused = false;
        try { action(); } catch (error) { refused = error.message.includes('No changes were saved'); }
        assert(refused, 'unsafe edit refused');
        equal(saved, raw);
        equal(readHidden(settings).length, 0);
        equal(visibleTasks(duplicates, settings).today.length, 3);
    }
}
const invalid = [null, {}, {key: identity, future: 'retain'}];
saved = JSON.stringify({version: 2, extra: {retain: true}, tasks: invalid});
hideTask(settings, task);
equal(JSON.stringify(JSON.parse(saved).tasks.slice(0, 3)), JSON.stringify(invalid));
unhideTask(settings, identity);
equal(JSON.stringify(JSON.parse(saved)), JSON.stringify({version: 2, extra: {retain: true}, tasks: invalid}));
for (const mismatch of [{description: 'Other task'}, {scheduled: '2026-12-31'}]) {
    saved = '{"version":2,"tasks":[]}';
    hideTask(settings, task);
    const record = readHidden(settings)[0];
    const sibling = {...task, content: 'Valid sibling'};
    hideTask(settings, sibling);
    const valid = readHidden(settings)[1];
    saved = JSON.stringify({version: 2, tasks: [{...record, ...mismatch}, valid]});
    equal(readHidden(settings).length, 1);
    equal(readHidden(settings)[0].description, 'Valid sibling');
    const visible = visibleTasks({today: [task, sibling], overdue: [], upcoming: []}, settings);
    equal(visible.today.length, 1);
    equal(visible.today[0].content, task.content);
}
