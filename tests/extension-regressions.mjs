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
    const candidates = [null, '2026-11-03'].flatMap(journal_date =>
        ['2026-11-03, Tue', 'Nov 3rd, 2026'].map(source_page =>
            ({...task, journal_date, source_page, block_uuid})));
    const grouped = {today: candidates, overdue: candidates, upcoming: candidates};
    for (const hidden of candidates) {
        const expected = Object.fromEntries(Object.entries(grouped).map(([section, tasks]) =>
            [section, tasks.filter(candidate => candidate.source_page !== hidden.source_page)]));
        const oldKey = JSON.stringify([hidden.graph_path, hidden.source_page, hidden.content, hidden.scheduled]);
        for (const existing of [false, true]) {
            raw = JSON.stringify({version: 2, tasks: existing ? [{key: oldKey,
                description: hidden.content, graph: hidden.graph, scheduled: hidden.scheduled}] : []});
            if (!existing) hideTask(settings, hidden);
            assert.equal(readHidden(settings)[0].key, oldKey);
            assert.deepEqual(visibleTasks(grouped, settings), expected);
            const distinct = [
                {...hidden, graph_path: '/other'}, {...hidden, content: 'Other'},
                {...hidden, scheduled: '2026-11-04'},
            ];
            assert.deepEqual(visibleTasks({...data, today: distinct}, settings).today, distinct);
            unhideTask(settings, oldKey);
            assert.deepEqual(visibleTasks(grouped, settings), grouped);
        }
    }
}
