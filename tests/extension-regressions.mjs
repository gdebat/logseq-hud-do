import assert from 'node:assert/strict';
import {hideTask, unhideTask, logicalIdentity, visibleTasks, displayContent} from '../extension/model.js';

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
