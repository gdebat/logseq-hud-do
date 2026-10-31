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
            expected_fields = {'id', 'content', 'status', 'priority', 'graph',
                               'source_file', 'source_page', 'journal_date',
                               'block_location', 'block_uuid', 'scheduled',
                               'deadline', 'deep_link'}
            for tasks in json.loads(result.stdout).values():
                for task in tasks:
                    self.assertEqual(set(task), expected_fields)
                    self.assertEqual(set(task['block_location']), {'line'})
            subprocess.run(['node', '--input-type=module', '-e', "import {parseTasks, sections, taskPresentation} from './extension/model.js'; import fs from 'node:fs'; import assert from 'node:assert/strict'; const data = parseTasks(fs.readFileSync(0, 'utf8')); assert.deepEqual(Object.keys(data).sort(), [...sections].sort()); for (const section of sections) { assert.equal(data[section].length, Number(process.argv[1])); for (const t of data[section]) { const v = taskPresentation(t); assert.equal(v.doing, t.status === 'DOING'); assert.equal(v.priority !== null, t.priority !== null); } }", str(len(STATUSES) * (len(PRIORITIES) + 1))], input=result.stdout, text=True, check=True, cwd=ROOT)

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
        rules = dict(re.findall(r'([^{}]+)\{([^{}]+)\}', css))
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
