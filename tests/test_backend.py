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
        tasks = parse('- TODO [#A] parent\n  DEADLINE: <2026-11-01 Sun>\n  - child\n    SCHEDULED: <2026-10-30 Fri>\n  - DOING [#C] nested\n    SCHEDULED: <2026-10-31 Sat +1w>\n    id:: 12345678-1234-1234-1234-123456789abc\n- DONE ignored\n- ```\n  - TODO code\n  ```\n- TODO final\n', 'g', 'pages/a.md')
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
        with self.assertRaisesRegex(ValueError, 'a.md.*invalid UTF-8'):
            self.scan()
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

    def test_owned_content_and_metadata_prose_cold_warm(self):
        self.write('journals/2026_10_31.md', '- TODO discuss SCHEDULED: <2026-10-30 Fri>\n  instructions\n  discuss DEADLINE: <2026-10-29 Thu>\n  custom:: metadata\n  - child\n    child instructions\n')
        for expected in (1, 0):
            result, stats = self.scan()
            self.assertEqual(stats['parsed'], expected)
            self.assertEqual(len(result['today']), 1)
            task = result['today'][0]
            self.assertEqual(task['content'], 'discuss SCHEDULED: <2026-10-30 Fri>\ninstructions\ndiscuss DEADLINE: <2026-10-29 Thu>')
            self.assertIsNone(task['scheduled'])
            self.assertIsNone(task['deadline'])

    def test_invalid_dates_fail_without_cached_absence(self):
        self.scan()
        for field in ('SCHEDULED', 'DEADLINE'):
            with self.subTest(field=field):
                self.write('journals/2026_10_31.md', f'- TODO invalid\n  {field}: <2026-02-30 Mon>')
                with self.assertRaisesRegex(ValueError, f'2026_10_31.md:2: invalid {field}'):
                    self.scan()
                with sqlite3.connect(self.cache) as db:
                    self.assertEqual(db.execute('SELECT count(*) FROM files').fetchone()[0], 0)

    def test_combined_scheduling_cold_warm(self):
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                lines = []
                for category, day in [('today', '2026-10-31'), ('overdue', '2026-10-30'), ('upcoming', '2026-11-07')]:
                    fields = [f'SCHEDULED: <{day}>', 'DEADLINE: <2026-11-02 Mon>']
                    if reverse:
                        fields.reverse()
                    lines.extend([f'- TODO {category}', '  ' + ' '.join(fields)])
                self.write('pages/a.md', '\n'.join(lines))
                for expected in (1, 0):
                    result, stats = self.scan()
                    self.assertEqual(stats['parsed'], expected)
                    for category, day in [('today', '2026-10-31'), ('overdue', '2026-10-30'), ('upcoming', '2026-11-07')]:
                        self.assertEqual(len(result[category]), 1)
                        task = result[category][0]
                        self.assertEqual(task['content'], category)
                        self.assertEqual(task['scheduled'], day)
                        self.assertEqual(task['deadline'], '2026-11-02')

    def test_malformed_scheduling_error_channel(self):
        self.scan()
        for field in ('SCHEDULED', 'DEADLINE'):
            for value in ('<>', '<2026-02-30 Mon> trailing', '', '2026-10-31', '<not-a-date>', '<2026-10-31'):
                for prefix in ('', 'DEADLINE: <2026-11-02> ' if field == 'SCHEDULED' else 'SCHEDULED: <2026-10-31> '):
                    with self.subTest(field=field, value=value, prefix=prefix):
                        self.write('journals/2026_10_31.md', f'- TODO invalid\n  {prefix}{field}: {value}')
                        with self.assertRaisesRegex(ValueError, f'2026_10_31.md:2: invalid {field}'):
                            self.scan()
                        result = subprocess.run([sys.executable, '-m', 'logseq_hud_do', '--graph', str(self.graph), '--cache', str(self.cache)], capture_output=True, text=True)
                        self.assertEqual(result.returncode, 1)
                        self.assertEqual(result.stdout, '')
                        self.assertIn(f'invalid {field}', json.loads(result.stderr)['error'])
                        with sqlite3.connect(self.cache) as db:
                            self.assertEqual(db.execute('SELECT count(*) FROM files').fetchone()[0], 0)

    def test_malformed_dates_in_prose_and_non_task_blocks(self):
        text = '- TODO discuss SCHEDULED: <>\n  discuss DEADLINE: <2026-02-30>\n  - child\n    SCHEDULED: <>\n- note\n  DEADLINE: <>\n'
        tasks = parse(text, 'g', 'pages/a.md')
        self.assertEqual(tasks[0]['content'], 'discuss SCHEDULED: <>\ndiscuss DEADLINE: <2026-02-30>')
        self.assertIsNone(tasks[0]['scheduled'])
        self.assertIsNone(tasks[0]['deadline'])

    def test_previous_parser_cache_upgrade(self):
        for version in (1, 2):
            with self.subTest(version=version):
                relative = 'journals/2026_10_31.md'
                self.write(relative, '- TODO original\n  full instructions\n  SCHEDULED: <2026-10-31> DEADLINE: <2026-11-02>')
                metadata = (self.graph / relative).stat()
                old = dict(id='old-parser-id', content='original', status='TODO', priority=None,
                           scheduled=None, deadline=None, graph=str(self.graph), source_file=relative,
                           source_page='2026_10_31', journal_date='2026-10-31',
                           block_location={'line': 1}, block_uuid=None)
                with sqlite3.connect(self.cache) as db:
                    db.execute('CREATE TABLE IF NOT EXISTS files (graph TEXT, path TEXT, mtime INTEGER, size INTEGER, tasks TEXT, PRIMARY KEY(graph,path))')
                    db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?)', (str(self.graph), relative, metadata.st_mtime_ns, metadata.st_size, json.dumps([old])))
                    db.execute(f'PRAGMA user_version={version}')
                for expected in (1, 0):
                    result, stats = self.scan()
                    self.assertEqual(stats['parsed'], expected)
                    self.assertEqual(stats['reused'], 1 - expected)
                    task = result['today'][0]
                    self.assertEqual(task['content'], 'original\nfull instructions')
                    self.assertEqual(task['scheduled'], '2026-10-31')
                    self.assertEqual(task['deadline'], '2026-11-02')
                    with sqlite3.connect(self.cache) as db:
                        self.assertGreater(db.execute('PRAGMA user_version').fetchone()[0], version)
                        stored = json.loads(db.execute('SELECT tasks FROM files').fetchone()[0])[0]
                    for field in ('content', 'scheduled', 'deadline'):
                        self.assertEqual(stored[field], task[field])

    def test_malformed_cached_records_reparsed(self):
        self.write('journals/2026_10_31.md', '- TODO original')
        self.scan()
        with sqlite3.connect(self.cache) as db:
            valid = json.loads(db.execute('SELECT tasks FROM files').fetchone()[0])[0]
        payloads = ['{', '{}', '[null]']
        for field in valid:
            missing = dict(valid)
            del missing[field]
            payloads.append(json.dumps([missing]))
            invalid = dict(valid, **{field: []})
            payloads.append(json.dumps([invalid]))
        for payload in payloads:
            with self.subTest(payload=payload):
                with sqlite3.connect(self.cache) as db:
                    db.execute('UPDATE files SET tasks=?', (payload,))
                result, stats = self.scan()
                self.assertEqual(stats['parsed'], 1)
                self.assertEqual(result['today'][0]['content'], 'original')
                self.assertEqual(self.scan()[1]['parsed'], 0)

    def test_modified_records_replace_persisted_output(self):
        self.write('pages/a.md', '- TODO original\n  SCHEDULED: <2026-10-30 Fri>')
        self.scan()
        self.write('pages/a.md', '- DOING replacement\n  SCHEDULED: <2026-11-01 Sun>')
        for expected in (1, 0):
            result, stats = self.scan()
            self.assertEqual(stats['parsed'], expected)
            self.assertEqual(result['overdue'], [])
            self.assertEqual(result['upcoming'][0]['content'], 'replacement')
            self.assertEqual(result['upcoming'][0]['status'], 'DOING')
            self.assertEqual(result['upcoming'][0]['scheduled'], '2026-11-01')
        with sqlite3.connect(self.cache) as db:
            records = json.loads(db.execute('SELECT tasks FROM files').fetchone()[0])
        self.assertEqual([r['content'] for r in records], ['replacement'])

    def test_post_discovery_symlink_replacement(self):
        from logseq_hud_do import backend
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'a.md').write_text('- TODO outside secret')
        original = backend.discover
        for component in ('leaf', 'directory'):
            with self.subTest(component=component):
                self.write('pages/a.md', '- TODO inside')
                def replace(graph):
                    found = original(graph)
                    (graph / 'pages/a.md').unlink()
                    if component == 'leaf':
                        (graph / 'pages/a.md').symlink_to(outside / 'a.md')
                    else:
                        (graph / 'pages').rmdir()
                        (graph / 'pages').symlink_to(outside, target_is_directory=True)
                    return found
                with patch.object(backend, 'discover', replace), self.assertRaises(OSError):
                    self.scan()
                if component == 'leaf':
                    (self.graph / 'pages/a.md').unlink()
                else:
                    (self.graph / 'pages').unlink()
                    (self.graph / 'pages').mkdir()

    def test_exact_block_and_page_links(self):
        identifier = '12345678-1234-1234-1234-123456789abc'
        self.write('journals/2026_10_31.md', f'- TODO block\n  id:: {identifier}\n- TODO page')
        for _ in range(2):
            result, _ = self.scan()
            self.assertEqual([t['deep_link'] for t in result['today']], [f'logseq://graph/graph?block-id={identifier}', 'logseq://graph/graph?page=2026_10_31'])

    def test_supported_roots_individually(self):
        for root in ('pages', 'journals'):
            graph = self.root / root
            (graph / root).mkdir(parents=True)
            (graph / root / 'a.md').write_text('- TODO task')
            self.assertEqual(scan([(graph, None)], self.cache, today=TODAY)[1]['parsed'], 1)

    def test_timezone_midnight_with_warm_cache(self):
        import time
        self.write('journals/2026_10_31.md', '- TODO local\n- TODO scheduled\n  SCHEDULED: <2026-10-31 Sat>')
        real_datetime = dt.datetime
        instant = real_datetime(2026, 10, 30, 21, 59, tzinfo=dt.timezone.utc)
        class Clock(real_datetime):
            @classmethod
            def now(cls):
                return instant.astimezone().replace(tzinfo=None)
        previous = os.environ.get('TZ')
        try:
            os.environ['TZ'] = 'Etc/GMT-2'
            time.tzset()
            with patch('logseq_hud_do.backend.dt.datetime', Clock):
                before, _ = scan([(self.graph, None)], self.cache)
                self.assertEqual(before['today'], [])
                self.assertEqual(len(before['upcoming']), 1)
                instant = real_datetime(2026, 10, 30, 22, 1, tzinfo=dt.timezone.utc)
                after, stats = scan([(self.graph, None)], self.cache)
                self.assertEqual(len(after['today']), 2)
                self.assertEqual(stats['parsed'], 0)
        finally:
            if previous is None:
                os.environ.pop('TZ', None)
            else:
                os.environ['TZ'] = previous
            time.tzset()
