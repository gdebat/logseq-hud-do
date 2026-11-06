"""Real producer/model, installer, graph and stylesheet boundary regressions."""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from logseq_hud_do.backend import scan, STATUSES, PRIORITIES, GRAPH_ROOTS

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    def test_preview_titles_and_real_ancestor_context_reach_ui(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture_text = (ROOT / 'tests/fixtures/block-context-root-heading.md').read_text()
            fixture_text = fixture_text.replace('2026-01-02 Fri', dt.date.today().isoformat())
            fixture_text = fixture_text.replace('\t\t\t- Direct child',
                '\t\t  ```text\n\t\t  - literal code\n\t\t  id:: code-only\n\t\t  ```\n\t\t\t- Direct child')
            journal_lines = fixture_text.splitlines()
            journal_text = '\n'.join(journal_lines[:6] + ['\t\t- Branch'] +
                                     ['\t' + line for line in journal_lines[6:]]) + '\n'
            previews = []
            for index in range(2):
                graph = root / f'graph-{index}'
                (graph / 'pages').mkdir(parents=True)
                (graph / 'journals').mkdir()
                (graph / 'pages/context.md').write_text('title:: Shared page\n' + fixture_text)
                (graph / 'journals' / f'{dt.date.today():%Y_%m_%d}.md').write_text(journal_text)
                if index:
                    (graph / 'logseq').mkdir()
                    (graph / 'logseq/config.edn').write_text('{:journal/page-title-format "yyyy-MM-dd, EEE"}')
                result = subprocess.run(
                    ['python3', '-m', 'logseq_hud_do', f'--graph={graph}', '--cache', str(root / 'cache')],
                    capture_output=True, text=True, check=True, cwd=ROOT)
                tasks = json.loads(result.stdout)['today']
                self.assertEqual(len(tasks), 2)
                for task in tasks:
                    context_result = subprocess.run(
                        ['python3', '-m', 'logseq_hud_do', f'--graph={graph}',
                         '--block-context', task['source_file'], task['id']],
                        capture_output=True, text=True, check=True, cwd=ROOT)
                    context = json.loads(context_result.stdout)
                    parents = ['### Root heading', '**Section**']
                    if task['source_file'].startswith('journals/'):
                        parents.append('Branch')
                    self.assertEqual([p['content'] for p in context['parent']], parents)
                    self.assertEqual([c['content'] for c in context['children']], ['Direct child'])
                    self.assertIn('```text\n- literal code\nid:: code-only\n```', context['current']['content'])
                    previews.append({'task': task, 'context': context})
            fixture = root / 'preview-fixture.json'
            fixture.write_text(json.dumps(previews))
            subprocess.run(['node', 'tests/extension-ui.mjs', str(fixture)], cwd=ROOT, check=True)

    def test_all_producer_vocabulary_reaches_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            graph = Path(tmp) / 'graph'
            (graph / 'pages').mkdir(parents=True)
            lines = []
            for delta in (-1, 0, 1):
                for status in STATUSES:
                    for priority in (*PRIORITIES, None):
                        lines.append(f'- {status} ' + (f'[#{priority}] ' if priority else '') + 'Task\n  SCHEDULED: <' + (dt.date.today() + dt.timedelta(days=delta)).isoformat() + '>')
            (graph / 'pages/tasks.md').write_text('\n'.join(lines))
            subprocess.run(['node', '--input-type=module', '-e', "import {statuses, priorities} from './extension/model.js'; import assert from 'node:assert/strict'; const expected = JSON.parse(process.argv[1]); assert.deepEqual(statuses, expected[0]); assert.deepEqual(Object.keys(priorities), expected[1]);", json.dumps([STATUSES, PRIORITIES])], check=True, cwd=ROOT)
            result = subprocess.run(['python3', '-m', 'logseq_hud_do', f'--graph={graph}', '--cache', str(Path(tmp) / 'cache')], capture_output=True, text=True, check=True)
            expected_fields = {'graph_path', 'id', 'content', 'status', 'priority', 'graph',
                               'source_file', 'source_page', 'journal_date',
                               'block_location', 'block_uuid', 'scheduled',
                               'deadline', 'deep_link'}
            for tasks in json.loads(result.stdout).values():
                for task in tasks:
                    self.assertEqual(set(task), expected_fields)
                    self.assertEqual(set(task['block_location']), {'line'})
            subprocess.run(['node', '--input-type=module', '-e', "import {parseTasks, sections, taskPresentation, logicalIdentity, displayContent} from './extension/model.js'; import fs from 'node:fs'; import assert from 'node:assert/strict'; const data = parseTasks(fs.readFileSync(0, 'utf8')); assert.deepEqual(Object.keys(data).sort(), [...sections].sort()); for (const section of sections) { assert.equal(data[section].length, Number(process.argv[1])); for (const t of data[section]) { const v = taskPresentation(t); assert.equal(v.doing, t.status === 'DOING'); assert.equal(v.priority !== null, t.priority !== null); assert.equal(displayContent(t.content), 'Task'); assert.equal(logicalIdentity(t), logicalIdentity({...t, content: 'Task', priority: null})); } }", str(len(STATUSES) * (len(PRIORITIES) + 1))], input=result.stdout, text=True, check=True, cwd=ROOT)

    def test_parser_identity_and_cross_graph_hiding(self):
        with tempfile.TemporaryDirectory() as tmp:
            graphs = [Path(tmp) / name for name in ('one', 'two')]
            for graph in graphs:
                (graph / 'pages').mkdir(parents=True)
                (graph / 'pages/tasks.md').write_text(
                    f'- TODO Report\n  note [#A]\n  SCHEDULED: <{dt.date.today()}>\n'
                    f'- TODO Report\n  note\n  SCHEDULED: <{dt.date.today()}>\n'
                    f'- TODO Report\n  note [#C]\n  SCHEDULED: <{dt.date.today()}>\n')
            command = ['python3', '-m', 'logseq_hud_do', '--cache', str(Path(tmp) / 'cache')]
            command.extend(f'--graph={graph}' for graph in graphs)
            for _ in range(2):
                result = subprocess.run(command, capture_output=True, text=True, check=True, cwd=ROOT)
                subprocess.run(['node', '--input-type=module', '-e', """
import {parseTasks, logicalIdentity, hideTask, visibleTasks} from './extension/model.js';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const data = parseTasks(fs.readFileSync(0, 'utf8'));
const tasks = Object.values(data).flat();
assert.equal(tasks.length, 6);
assert.deepEqual([...new Set(tasks.map(t => t.graph_path))].sort(), JSON.parse(process.argv[1]).sort());
assert.equal(new Set(tasks.map(logicalIdentity)).size, 6);
let raw = '{"version":2,"tasks":[]}';
const settings = {get_string: () => raw, set_string: (_, value) => raw = value};
hideTask(settings, tasks[0]);
const visible = Object.values(visibleTasks(data, settings)).flat();
assert.equal(visible.length, 5);
assert.equal(visible.filter(t => t.graph_path !== tasks[0].graph_path).length, 3);
assert(visible.some(t => t.graph_path === tasks[0].graph_path));
""", json.dumps([str(g.resolve()) for g in graphs])], input=result.stdout, text=True, check=True, cwd=ROOT)

    def test_continuation_priority_presentation(self):
        with tempfile.TemporaryDirectory() as tmp:
            graph = Path(tmp) / 'graph'
            (graph / 'pages').mkdir(parents=True)
            (graph / 'pages/tasks.md').write_text('\n'.join(
                f'- DOING [#{marker}] Report\n  note [#{marker}]\n  SCHEDULED: <{dt.date.today()}>'
                for marker in PRIORITIES))
            result = subprocess.run(['python3', '-m', 'logseq_hud_do', f'--graph={graph}',
                                     '--cache', str(Path(tmp) / 'cache')],
                                    capture_output=True, text=True, check=True, cwd=ROOT)
            subprocess.run(['node', '--input-type=module', '-e', """
import {parseTasks, taskPresentation, logicalIdentity, priorities} from './extension/model.js';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const tasks = Object.values(parseTasks(fs.readFileSync(0, 'utf8'))).flat();
assert.equal(tasks.length, 3);
for (const task of tasks) {
    const note = `note [#${task.priority}]`;
    assert.equal(task.content, `[#${task.priority}] Report\\n${note}`);
    assert.equal(taskPresentation(task).content, `Report\\n${note}`);
    assert.equal(taskPresentation(task, ['^\\\\[#' + task.priority + '\\\\]']).content, note);
    assert.equal(taskPresentation(task, [], [[task.content.split('\\n')[0], 'END']]).content, `Report\\n${note}`);
    assert.deepEqual(taskPresentation(task).priority, priorities[task.priority]);
    assert.equal(taskPresentation(task).doing, true);
    assert.equal(logicalIdentity(task), logicalIdentity({...task, content: `Report\\n${note}`}));
    assert.notEqual(logicalIdentity(task), logicalIdentity({...task, content: 'Report\\nnote'}));
}
"""], input=result.stdout, text=True, check=True, cwd=ROOT)

    def test_journal_hidden_identity_producer_conformance(self):
        with tempfile.TemporaryDirectory() as tmp:
            graph = Path(tmp) / 'graph'
            (graph / 'journals').mkdir(parents=True)
            (graph / 'logseq').mkdir()
            today = dt.date(2028, 1, 1)
            for offset in range(366):
                day = today + dt.timedelta(days=offset)
                (graph / 'journals' / (day.strftime('%Y_%m_%d') + '.md')).write_text(
                    f'- TODO Task\n  SCHEDULED: <{today}>\n'
                    f'- TODO Block\n  id:: 12345678-1234-1234-1234-{offset:012x}\n  SCHEDULED: <{today}>')
            outputs = []
            for setting in ('{}', '{:journal/page-title-format "yyyy-MM-dd, EEE"}',
                            '{:journal/page-title-format "yyyy-MM-dd"}', '{}'):
                (graph / 'logseq/config.edn').write_text(setting)
                data, _ = scan([(graph, 'Graph')], Path(tmp) / 'cache', today=today)
                outputs.append(data)
            for task in outputs[1]['today']:
                if task['block_uuid'] is None:
                    source = graph / task['source_file']
                    source.write_text(f"title:: {task['source_page']}\n" + source.read_text())
            data, _ = scan([(graph, 'Graph')], Path(tmp) / 'cache', today=today)
            outputs.append(data)
            subprocess.run(['node', '--input-type=module', '-e', """
import {hideTask, visibleTasks} from './extension/model.js';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const outputs = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.equal(outputs[0].today.length, 732);
for (const origin of outputs.slice(0, 2)) {
    for (const task of origin.today) {
        let raw = '{"version":2,"tasks":[]}';
        const settings = {get_string: () => raw, set_string: (_, value) => raw = value};
        hideTask(settings, task);
        assert.equal(JSON.parse(raw).tasks.length, 1);
        for (const data of outputs) {
            const visible = visibleTasks(data, settings).today;
            const expected = data.today.filter(candidate => candidate.source_page !== task.source_page ||
                candidate.content !== task.content);
            assert.deepEqual(visible, expected, task.source_file);
        }
    }
}
for (const task of outputs[3].today) {
    const key = JSON.stringify([task.graph_path, task.source_page, task.content, task.scheduled]);
    let raw = JSON.stringify({version: 2, tasks: [{key, description: task.content,
        graph: task.graph, scheduled: task.scheduled}]});
    const settings = {get_string: () => raw, set_string: (_, value) => raw = value};
    assert.equal(visibleTasks({today: [task], overdue: [], upcoming: []}, settings).today.length, 0);
}
"""], input=json.dumps(outputs), text=True, check=True, cwd=ROOT)

    def test_hidden_identity_and_badge_documentation(self):
        readme = (ROOT / 'README.md').read_text()
        self.assertIn('graph, page, normalized content and scheduled', readme)
        self.assertIn('Different scheduled dates or graphs produce separate hidden identities.', readme)
        requirements = (ROOT / 'docs/requirements.md').read_text()
        self.assertIn('prominent green `Doing` badge', requirements)
        self.assertIn('`Doing` status badge after the priority badge', requirements)
        self.assertNotIn('`DOING` badge', requirements)
        self.assertIn('priority badges followed by a green `Doing` badge',
                      (ROOT / 'docs/ui-acceptance.md').read_text())

    def test_real_schema_ranges(self):
        with tempfile.TemporaryDirectory() as tmp:
            import shutil
            shutil.copy(next((ROOT / 'extension/schemas').glob('*.xml')), tmp)
            subprocess.run(['glib-compile-schemas', '--strict', tmp], check=True)
            code = """const Gio = imports.gi.Gio;
const source = Gio.SettingsSchemaSource.new_from_directory(ARGV[0], Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup('org.gnome.shell.extensions.logseq-hud-do', false);
for (const key of ['refresh-interval', 'horizon']) {
    const [, bounds] = schema.get_key(key).get_range().deep_unpack();
    const [lower, upper] = bounds.deep_unpack();
    if (!(Number.isInteger(lower) && Number.isInteger(upper) && lower < upper)) throw Error('Invalid bounds');
}
"""
            subprocess.run(['gjs', '-c', code, tmp], check=True)

    def test_hidden_registry_persists_between_processes(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(next((ROOT / 'extension/schemas').glob('*.xml')), tmp)
            subprocess.run(['glib-compile-schemas', '--strict', tmp], check=True)
            env = dict(os.environ, GSETTINGS_BACKEND='keyfile', XDG_CONFIG_HOME=tmp)
            setup = """const Gio = imports.gi.Gio;
const source = Gio.SettingsSchemaSource.new_from_directory(ARGV[0], Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.logseq-hud-do', false)});
"""
            module = (ROOT / 'extension/model.js').as_uri()
            script = Path(tmp) / 'registry.mjs'
            script.write_text(f"import {{readHidden, hideTask, hiddenRegistryVersion}} from '{module}';\n" +
                              "import Gio from 'gi://Gio';\n" + setup.replace('const Gio = imports.gi.Gio;\n', '') + """
function check(value) { if (!value) throw Error('Registry contract failed'); }
check(JSON.parse(settings.get_string('hidden-tasks-v2')).version === hiddenRegistryVersion);
if (ARGV[1] === 'write') {
    check(settings.get_boolean('show-today-unscheduled') === true);
    settings.set_boolean('show-today-unscheduled', false);
    check(readHidden(settings).length === 0);
    hideTask(settings, {graph_path: '/graph', source_page: 'Page', content: 'Task', graph: 'Graph', scheduled: null});
    Gio.Settings.sync();
} else {
    check(settings.get_boolean('show-today-unscheduled') === false);
    check(readHidden(settings).length === 1);
    check(readHidden(settings)[0].description === 'Task');
    settings.set_string('hidden-tasks-v2', JSON.stringify({version: hiddenRegistryVersion + 1, tasks: readHidden(settings)}));
    check(readHidden(settings).length === 0);
}
""")
            for mode in ('write', 'read'):
                subprocess.run(['gjs', '-m', str(script), tmp, mode], env=env, check=True)

    def test_symlink_roots(self):
        subprocess.run(['node', 'tests/extension-prefs.mjs', json.dumps(GRAPH_ROOTS)], check=True, cwd=ROOT)
        for roots in [*((name,) for name in GRAPH_ROOTS), GRAPH_ROOTS]:
            with self.subTest(roots=roots), tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                graph = base / 'graph'
                graph.mkdir()
                target = base / 'target'
                target.mkdir()
                for name in roots:
                    (graph / name).symlink_to(target)
                with self.assertRaisesRegex(ValueError, 'non-symlink'):
                    scan([(graph, 'Fixture')], base / 'cache')
                for name in roots:
                    (graph / name).unlink()
                    (graph / name).mkdir()
                scan([(graph, 'Fixture')], base / 'cache')

    def test_unsupported_graph_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            graph = Path(tmp) / 'graph'
            (graph / 'unsupported').mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, 'invalid graph directory'):
                scan([(graph, 'Fixture')], Path(tmp) / 'cache')

    def test_installer_versions(self):
        supported = json.loads((ROOT / 'extension/metadata.json').read_text())['shell-version']
        self.assertEqual(supported, ['46', '47', '48', '49', '50'])
        for version in supported + ['45', '51', 'unknown']:
            with self.subTest(version=version), tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                shell = base / 'gnome-shell'
                shell.write_text(f'#!/bin/sh\necho "GNOME Shell {version}.0"\n')
                shell.chmod(0o755)
                env = dict(os.environ, PATH=tmp + ':' + os.environ['PATH'], XDG_DATA_HOME=str(base / 'data'))
                result = subprocess.run(['sh', 'scripts/install-extension.sh'], cwd=ROOT, env=env, capture_output=True)
                self.assertEqual(result.returncode == 0, version in supported, result.stderr)

    def test_theme_contrast_and_inheritance(self):
        import re
        css = (ROOT / 'extension/stylesheet.css').read_text()
        rules = {selector.strip(): body for selector, body in re.findall(r'([^{}]+)\{([^{}]+)\}', css)}
        self.assertNotIn('opacity', rules['.hud-context'])
        self.assertIn('background-color:', rules['.hud-task:hover, .hud-task:focus'])
        self.assertNotIn('opacity', rules['.hud-task'])
        self.assertIn('background-color: #237b37', rules['.hud-doing'])
        self.assertIn('background-color: #1a5fb4', rules['.hud-low'])
        def luminance(value):
            rgb = [int(value[i:i+2], 16) / 255 for i in (0, 2, 4)]
            return sum(w * (v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4) for w, v in zip((.2126, .7152, .0722), rgb))
        for theme in ('ffffff', '242424'):
            for selector, body in rules.items():
                colors = dict(re.findall(r'(background-color|color):\s*#([0-9a-f]{6})', body))
                if selector.strip() in ('.hud-doing', '.hud-high', '.hud-medium', '.hud-low'):
                    self.assertEqual(set(colors), {'color', 'background-color'})
                    a, b = sorted(map(luminance, colors.values()))
                    self.assertGreaterEqual((b + .05) / (a + .05), 4.5)
                else:
                    self.assertNotRegex(body, r'(?<!-)color\s*:')
                    # Text inherits the Shell foreground in either theme.
                    foreground = '242424' if theme == 'ffffff' else 'ffffff'
                    a, b = sorted((luminance(theme), luminance(foreground)))
                    self.assertGreater((b + .05) / (a + .05), 4.5)
