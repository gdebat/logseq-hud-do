import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hideTask, unhideTask, logicalIdentity, visibleTasks, displayContent, readHidden} from '../extension/model.js';

const task = {graph_path: '/graph', source_page: 'Page', content: 'Task', graph: 'Graph', scheduled: null};
const key = logicalIdentity(task);
const record = {key, description: 'Task', graph: 'Graph', scheduled: null};
let raw;
let writable = true;
const settings = {get_string: () => raw, set_string: (_, value) => {
    if (!writable) return false;
    raw = value;
    return true;
}};
const data = {today: [task], overdue: [], upcoming: []};
const cases = {
    R1() {
        const extra = {...record, future: {keep: true}};
        const unrelated = {future: 'unrelated'};
        raw = JSON.stringify({version: 2, future: 'envelope', tasks: [extra, unrelated]});
        hideTask(settings, {...task, graph: 'Renamed'});
        assert.deepEqual(JSON.parse(raw), {version: 2, future: 'envelope',
            tasks: [{...extra, graph: 'Renamed'}, unrelated]});
        const before = raw;
        assert.throws(() => unhideTask(settings, key), /unknown fields.*Unhide All/i);
        assert.equal(raw, before);
        assert.equal(visibleTasks(data, settings).today.length, 0);
        raw = JSON.stringify({version: 2, tasks: [record, unrelated]});
        unhideTask(settings, key);
        assert.deepEqual(JSON.parse(raw).tasks, [unrelated]);
        assert.equal(visibleTasks(data, settings).today.length, 1);
    },
    R2() {
        for (const marker of ['A', 'B', 'C']) {
            const continuation = '[#A] literal\n[#B] literal\n[#C] literal';
            assert.equal(displayContent(`[#${marker}] Secret\n${continuation}`, ['^\\[#' + marker + '\\] Secret']), continuation);
            assert.equal(displayContent(`[#${marker}] BEGIN\nSecret\nEND\n${continuation}`, [], [[`[#${marker}] BEGIN`, 'END']]), continuation);
            assert.equal(displayContent(`[#${marker}] BEGIN\n${continuation}`, [], [[`[#${marker}] BEGIN`, 'END']]), `BEGIN\n${continuation}`);
        }
    },
    R3() {
        for (const [action, tasks, count] of [[() => hideTask(settings, task), [], 1],
            [() => unhideTask(settings, key), [record], 0]]) {
            raw = JSON.stringify({version: 2, tasks});
            const before = raw;
            writable = false;
            assert.throws(action, /could not be saved/i);
            assert.equal(raw, before);
            assert.equal(visibleTasks(data, settings).today.length, count);
            writable = true;
            action();
            assert.equal(visibleTasks(data, settings).today.length, 1 - count);
        }
    },
};
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases)) {
    cases[name]();
    console.log(name + ' passed');
}

async function checkFieldAgreement() {
    const source = fs.readFileSync(new URL('../extension/model.js', import.meta.url), 'utf8');
    const extended = source.replace('const hiddenRecordFields = {',
        "const hiddenRecordFields = { supportedExtension: {value: () => 'value', valid: value => value === 'value'},");
    assert.notEqual(extended, source);
    const extendedModel = await import('data:text/javascript;base64,' + Buffer.from(extended).toString('base64'));
    for (const model of [{hideTask, unhideTask, readHidden}, extendedModel]) {
        for (const scheduled of [null, '2026-11-01']) {
            raw = JSON.stringify({version: 2, tasks: []});
            const input = {...task, scheduled};
            model.hideTask(settings, input);
            const [generated] = JSON.parse(raw).tasks;
            assert.deepEqual(generated, {...record, key: logicalIdentity(input), scheduled,
                ...(model === extendedModel ? {supportedExtension: 'value'} : {})});
            assert.deepEqual(model.readHidden(settings), [generated]);
            model.unhideTask(settings, generated.key);
            assert.deepEqual(JSON.parse(raw).tasks, []);
            if (model === extendedModel) {
                raw = JSON.stringify({version: 2, tasks: [{...generated, supportedExtension: 42}]});
                assert.deepEqual(model.readHidden(settings), []);
            }
        }
    }
}
await checkFieldAgreement();
console.log('Supported-field construction, validation and Unhide agreement passed');

for (const block_uuid of [null, '12345678-1234-1234-1234-123456789abc']) {
    const journal = {...task, journal_date: '2026-11-03', source_page: 'Nov 3rd, 2026', block_uuid};
    const custom = {...journal, source_page: '2026-11-03, Tue'};
    for (const hidden of [journal, custom]) {
        raw = JSON.stringify({version: 2, tasks: []});
        hideTask(settings, hidden);
        for (const shown of [journal, custom, journal, custom])
            assert.equal(visibleTasks({...data, today: [shown]}, settings).today.length, 0);
        assert.equal(readHidden(settings)[0].key, logicalIdentity(journal));
    }
}

for (const block_uuid of [null, '12345678-1234-1234-1234-123456789abc']) {
    const journal = {...task, journal_date: '2026-11-03', source_page: '2026-11-03, Tue', block_uuid};
    const ordinary = {...journal, journal_date: null};
    const legacy = {...journal, source_page: 'Nov 3rd, 2026'};
    const candidates = [journal, ordinary, legacy];
    const grouped = {today: candidates, overdue: candidates, upcoming: candidates};
    for (const hidden of candidates) {
        raw = JSON.stringify({version: 2, tasks: []});
        hideTask(settings, hidden);
        assert(Object.values(visibleTasks(grouped, settings)).every(tasks => tasks.length === 0));
        const distinct = [
            {...journal, graph_path: '/other'}, {...journal, content: 'Other'},
            {...journal, scheduled: '2026-11-04'}, {...journal, source_page: '2026-11-03, Mon'},
            {...journal, source_page: '2026-02-30, Mon'}, {...journal, source_page: '9999-99-99, Sun'},
        ];
        assert.deepEqual(visibleTasks({...data, today: distinct}, settings).today, distinct);
        unhideTask(settings, readHidden(settings)[0].key);
        assert.deepEqual(visibleTasks(grouped, settings), grouped);
        const oldKey = JSON.stringify([hidden.graph_path, hidden.source_page, hidden.content, hidden.scheduled]);
        raw = JSON.stringify({version: 2, tasks: [{key: oldKey, description: hidden.content,
            graph: hidden.graph, scheduled: hidden.scheduled}]});
        assert(Object.values(visibleTasks(grouped, settings)).every(tasks => tasks.length === 0));
        unhideTask(settings, oldKey);
        assert.deepEqual(visibleTasks(grouped, settings), grouped);
    }
}
