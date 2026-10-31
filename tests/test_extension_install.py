"""Exercise the bundled backend and schema in a disposable user installation."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ExtensionInstallTests(unittest.TestCase):
    def test_standalone_installer_bundles_root_vocabulary(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            env = dict(os.environ, HOME=temp, XDG_DATA_HOME=str(home / 'data'))
            subprocess.run(['sh', str(ROOT / 'scripts/install.sh')], env=env, check=True)
            subprocess.run([str(home / '.local/bin/logseq-hud-do'), '--help'],
                           cwd=home, env=env, check=True, capture_output=True)

    def test_installed_backend_and_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            env = dict(os.environ, HOME=temp, XDG_DATA_HOME=str(home / 'data'),
                       XDG_CACHE_HOME=str(home / 'cache'))
            subprocess.run(['sh', str(ROOT / 'scripts/install-extension.sh')],
                           env=env, check=True, capture_output=True)
            installed = home / 'data/gnome-shell/extensions/logseq-hud-do@local'
            self.assertTrue((installed / 'schemas/gschemas.compiled').is_file())
            env['GSETTINGS_SCHEMA_DIR'] = str(installed / 'schemas')
            env['GSETTINGS_BACKEND'] = 'memory'
            result = subprocess.run(['gsettings', 'get',
                                     'org.gnome.shell.extensions.logseq-hud-do',
                                     'refresh-interval'], env=env, check=True,
                                    capture_output=True, text=True)
            self.assertEqual(result.stdout.strip(), '30')
            graph = home / 'Fixture Graph'
            (graph / 'pages').mkdir(parents=True)
            from datetime import date
            source = graph / 'pages/Example.md'
            content = f'- TODO [#A] A task\n  SCHEDULED: <{date.today().isoformat()}>\n'
            source.write_text(content)
            env['PYTHONPATH'] = str(installed)
            result = subprocess.run(['python3', '-m', 'logseq_hud_do',
                                     f'--graph={graph}', '--graph-name=Fixture'],
                                    cwd=installed, env=env, check=True,
                                    capture_output=True, text=True)
            task = json.loads(result.stdout)['today'][0]
            self.assertEqual(task['priority'], 'A')
            self.assertEqual(task['graph'], 'Fixture')
            self.assertTrue(task['deep_link'].startswith('logseq://graph/'))
            self.assertEqual(source.read_text(), content)
            failed = subprocess.run(['python3', '-m', 'logseq_hud_do',
                                     f'--graph={home / "missing"}'], cwd=installed,
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('error', json.loads(failed.stderr))
