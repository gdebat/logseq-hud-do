import concurrent.futures
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from logseq_hud_do.backend import parse, scan, journal_date

TODAY = dt.date(2026, 10, 31)


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.graph = self.root / 'graph'
        (self.graph / 'pages').mkdir(parents=True)
        (self.graph / 'journals').mkdir()
        self.cache = self.root / 'cache.sqlite'

    def write(self, path, text):
        (self.graph / path).write_text(text)

    def scan(self, **kw):
        return scan([(self.graph, 'Work')], self.cache, today=TODAY, **kw)

    def test_extraction_and_nested_ownership(self):
        tasks = parse('- TODO [#A] parent\n  DEADLINE: <2026-11-01 Sun>\n  - child\n    SCHEDULED: <2026-10-30 Fri>\n  - DOING [#C] nested\n    SCHEDULED: <2026-10-31 Sat +1w>\n    id:: 12345678-1234-1234-1234-123456789abc\n- DONE ignored\n- ```\n  - TODO code\n  ```\n- TODO bad\n  SCHEDULED: <2026-02-30 Mon>\n', 'g', 'pages/a.md')
        self.assertEqual(len(tasks), 3)
        self.assertEqual([t['status'] for t in tasks], ['TODO', 'DOING', 'TODO'])
        self.assertEqual(tasks[0]['deadline'], '2026-11-01')
        self.assertIsNone(tasks[0]['scheduled'])
        self.assertEqual(tasks[1]['scheduled'], '2026-10-31')
        self.assertEqual(tasks[1]['block_uuid'], '12345678-1234-1234-1234-123456789abc')
        self.assertIsNone(tasks[2]['scheduled'])
        self.assertEqual([t['priority'] for t in tasks], ['A', 'C', None])

    def test_stable_fallback(self):
        one = parse('- TODO same\n- TODO same', 'g', 'pages/a.md')
        two = parse('- note\n- TODO same\n- TODO same', 'g', 'pages/a.md')
        self.assertEqual([t['id'] for t in one], [t['id'] for t in two])
        self.assertNotEqual(one[0]['id'], one[1]['id'])

    def test_classification_sorting_rollover(self):
        self.write('journals/2026_10_31.md', '- TODO journal\n- TODO deadline\n  DEADLINE: <2026-10-31 Sat>')
        self.write('pages/a.md', '- TODO [#A] today\n  SCHEDULED: <2026-10-31 Sat>\n- DOING low\n  SCHEDULED: <2026-10-31 Sat>\n- TODO old\n  SCHEDULED: <2026-10-29 Thu>\n- TODO earlier\n  SCHEDULED: <2026-10-28 Wed>\n- TODO seventh\n  SCHEDULED: <2026-11-07 Sat>\n- TODO eighth\n  SCHEDULED: <2026-11-08 Sun>\n- TODO excluded')
        result, _ = self.scan()
        self.assertEqual([t['content'] for t in result['today']], ['low', '[#A] today', 'journal'])
        self.assertEqual([t['content'] for t in result['overdue']], ['earlier', 'old'])
        self.assertEqual([t['content'] for t in result['upcoming']], ['seventh'])
        result, stats = scan([(self.graph, 'Work')], self.cache, today=TODAY + dt.timedelta(days=1))
        self.assertEqual(result['today'], [])
        self.assertEqual(stats['parsed'], 0)
        self.assertEqual(len(result['overdue']), 4)

    def test_incremental_and_rescan(self):
        self.write('pages/a.md', '- TODO task')
        self.assertEqual(self.scan()[1]['parsed'], 1)
        before = self.cache.read_bytes()
        self.assertEqual(self.scan()[1]['reused'], 1)
        self.assertEqual(before, self.cache.read_bytes())
        self.write('pages/a.md', '- DOING changed')
        self.assertEqual(self.scan()[1]['parsed'], 1)
        self.write('pages/b.md', '- TODO new')
        self.assertEqual(self.scan()[1]['parsed'], 1)
        (self.graph / 'pages/a.md').unlink()
        self.assertEqual(self.scan()[1]['removed'], 1)
        self.assertEqual(self.scan(full_rescan=True)[1]['parsed'], 1)
        with sqlite3.connect(self.cache) as db:
            db.execute('PRAGMA user_version=999')
        self.assertEqual(self.scan()[1]['parsed'], 1)
        self.cache.write_bytes(b'broken cache')
        self.assertEqual(self.scan()[1]['parsed'], 1)

    def test_multiple_graphs_and_links(self):
        second = self.root / 'other'
        (second / 'journals').mkdir(parents=True)
        self.write('journals/2026_10_31.md', '- TODO same')
        (second / 'journals/2026_10_31.md').write_text('- TODO same')
        result, _ = scan([(self.graph, 'One'), (second, 'Two')], self.cache, today=TODAY)
        self.assertEqual({t['graph'] for t in result['today']}, {'One', 'Two'})
        self.assertEqual(len({t['id'] for t in result['today']}), 2)
        self.assertTrue(all(t['deep_link'].startswith('logseq://graph/') for t in result['today']))

    def test_journal_formats(self):
        for name in ('2026_10_31', '2026-10-31', 'Oct 31, 2026', 'October 31, 2026'):
            self.assertEqual(journal_date('journals/' + name + '.md'), '2026-10-31')
        self.assertIsNone(journal_date('pages/2026_10_31.md'))

    def test_symlinks_and_invalid_configuration(self):
        outside = self.root / 'outside.md'
        outside.write_text('- TODO secret')
        (self.graph / 'pages/link.md').symlink_to(outside)
        (self.graph / 'pages/dir').symlink_to(self.root, target_is_directory=True)
        self.assertEqual(self.scan()[1]['discovered'], 0)
        for graphs, cache, options in [([], self.cache, {}), ([(self.root / 'missing', None)], self.cache, {}), ([(self.graph, None)] * 2, self.cache, {}), ([(self.graph, None)], self.graph / 'cache', {}), ([(self.graph, None)], self.cache, {'horizon': -1})]:
            with self.assertRaises(ValueError):
                scan(graphs, cache, **options)
        self.assertFalse((self.graph / 'cache').exists())

    def test_interrupted_transaction_and_concurrent_processes(self):
        self.write('pages/a.md', '- TODO original')
        self.scan()
        self.write('pages/a.md', '- TODO replacement')
        self.write('pages/b.md', '- TODO new')
        from logseq_hud_do import backend
        original = backend.parse
        def fail(text, graph, relative):
            if relative.endswith('b.md'):
                raise OSError('interrupted')
            return original(text, graph, relative)
        with patch.object(backend, 'parse', fail), self.assertRaises(OSError):
            self.scan()
        with sqlite3.connect(self.cache) as db:
            self.assertIn('original', db.execute('SELECT tasks FROM files').fetchone()[0])
        command = [sys.executable, '-m', 'logseq_hud_do', '--graph', str(self.graph), '--cache', str(self.cache), '--diagnostics']
        with concurrent.futures.ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda _: subprocess.run(command, capture_output=True, text=True), range(4)))
        self.assertTrue(all(r.returncode == 0 for r in results))
        self.assertEqual(sorted(json.loads(r.stderr)['parsed'] for r in results), [0, 0, 0, 2])
        self.assertTrue(all(set(json.loads(r.stdout)) == {'today', 'overdue', 'upcoming'} for r in results))

    def test_local_day_used_each_refresh(self):
        self.write('journals/2026_10_31.md', '- TODO local')
        class Clock(dt.datetime):
            @classmethod
            def now(cls):
                return dt.datetime(2026, 10, 31, 0, 1).astimezone()
        with patch('logseq_hud_do.backend.dt.datetime', Clock):
            result, _ = scan([(self.graph, None)], self.cache)
        self.assertEqual(len(result['today']), 1)

    def test_invalid_utf8_and_cli_error(self):
        (self.graph / 'pages/a.md').write_bytes(b'- TODO bad\xff')
        self.assertEqual(self.scan()[1]['extracted_tasks'], 1)
        result = subprocess.run([sys.executable, '-m', 'logseq_hud_do', '--graph', str(self.root / 'missing'), '--cache', str(self.cache)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('error', json.loads(result.stderr))

    def test_priority_order_and_duplicate_uuid(self):
        from logseq_hud_do.backend import classify
        text = '\n'.join('- ' + status + ' ' + priority + ' task' for status in ('TODO', 'DOING') for priority in ('', '[#C]', '[#B]', '[#A]'))
        tasks = parse(text, 'g', 'journals/2026_10_31.md')
        result = classify(tasks + tasks, TODAY, 7)['today']
        self.assertEqual(len(result), 8)
        self.assertEqual([t['priority'] for t in result], ['A', 'B', 'C', None] * 2)
        self.assertEqual([t['status'] for t in result], ['DOING'] * 4 + ['TODO'] * 4)
