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
from logseq_hud_do.backend import parse, scan, journal_date, block_context, blocks

ROOT_DIR = Path(__file__).resolve().parents[1]

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

    def test_tab_nested_scheduled_scans(self):
        fixtures = {
            "journals/2026_11_02.md": "- Parent block on yesterday's journal\n\t- TODO Task under the parent block on yesterday's journal\n\t  SCHEDULED: <2026-11-03 Tue>",
            "journals/2026_11_03.md": "- Parent block on today's journal\n\t- TODO Task under the parent block in today's journal\n\t  SCHEDULED: <2026-11-03 Tue>",
            "pages/Test Page.md": "- Parent block on a test page\n\t- TODO Task under the parent block on a test page\n\t  SCHEDULED: <2026-11-03 Tue>",
        }
        for status in ('TODO', 'DOING'):
            for relative, text in fixtures.items():
                self.write(relative, text.replace('TODO', status))
            for mode, options, parsed in [('cold', {}, 3), ('warm', {}, 0),
                                          ('full', {'full_rescan': True}, 3)]:
                with self.subTest(status=status, mode=mode):
                    result, stats = scan([(self.graph, 'Work')], self.cache,
                                         today=dt.date(2026, 11, 3), **options)
                    self.assertEqual(stats['parsed'], parsed)
                    self.assertEqual(stats['reused'], 3 - parsed)
                    self.assertEqual({t['source_file'] for t in result['today']}, set(fixtures))
                    self.assertEqual([(t['status'], t['scheduled']) for t in result['today']],
                                     [(status, '2026-11-03')] * 3)
                    self.assertEqual(result['overdue'], [])
                    self.assertEqual(result['upcoming'], [])

    def test_tab_single_space_metadata(self):
        for status in ('TODO', 'DOING'):
            with self.subTest(status=status):
                tasks = parse(f'- parent\n\t- {status} child\n\t SCHEDULED: <2026-11-03>\n',
                              'g', 'pages/a.md')
                self.assertEqual(tasks[0]['scheduled'], '2026-11-03')

    def test_tab_metadata_ownership(self):
        identifier = '12345678-1234-1234-1234-123456789abc'
        text = ('- TODO parent\n\t- TODO child\n\t  SCHEDULED: <2026-10-31>\n'
                '\t  DEADLINE: <2026-11-02>\n'
                f'\t  id:: {identifier}\n\t  instructions\n\t  \n\t  more\n'
                '    - DOING sibling\n      DEADLINE: <2026-11-03>\n'
                '\t\t- note\n\t\t  SCHEDULED: <2026-11-04>\n'
                '- TODO final\n  - note\n    SCHEDULED: <2026-11-05>\n'
                '\t- TODO expired\n    SCHEDULED: <2026-11-06>\n'
                '\t  DEADLINE: <2026-11-07>\n\t  ignored\n')
        tasks = parse(text, 'g', 'pages/a.md')
        parent, child, sibling, final, expired = tasks
        self.assertEqual(child['scheduled'], '2026-10-31')
        self.assertEqual(child['deadline'], '2026-11-02')
        self.assertEqual(child['block_uuid'], identifier)
        self.assertEqual(child['content'], 'child\ninstructions\n\nmore')
        self.assertEqual(sibling['deadline'], '2026-11-03')
        for task in (parent, sibling, final, expired):
            self.assertIsNone(task['scheduled'])
            self.assertIsNone(task['block_uuid'])
        for task in (parent, final, expired):
            self.assertIsNone(task['deadline'])
        self.assertEqual(expired['content'], 'expired')

    def test_tab_unscheduled_exclusions(self):
        for relative in ('journals/2026_10_30.md', 'journals/2026_10_31.md', 'pages/a.md'):
            self.write(relative, '- Parent\n\t- TODO unscheduled')
        for _ in range(2):
            result, _ = self.scan()
            self.assertEqual([t['source_file'] for t in result['today']], ['journals/2026_10_31.md'])
            self.assertEqual(result['overdue'], [])
            self.assertEqual(result['upcoming'], [])

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
            for value in ('<>', '<2026-02-30 Mon> trailing', '<2026-10-31> trailing', '', '2026-10-31', '<not-a-date>', '<2026-10-31'):
                for prefix in ('', 'DEADLINE: <2026-11-02> ' if field == 'SCHEDULED' else 'SCHEDULED: <2026-10-31> '):
                    with self.subTest(field=field, value=value, prefix=prefix):
                        self.write('journals/2026_10_31.md', f'- TODO invalid\n  {prefix}{field}: {value}')
                        with self.assertRaisesRegex(ValueError, f'2026_10_31.md:2: invalid {field}'):
                            self.scan()
                        result = subprocess.run([sys.executable, '-m', 'logseq_hud_do', '--graph', str(self.graph), '--cache', str(self.cache)], capture_output=True, text=True)
                        self.assertEqual(result.returncode, 1)
                        self.assertEqual(result.stdout, '')
                        self.assertIn(f'invalid {field}', json.loads(result.stderr)['error'])
                        self.assertIn('2026_10_31.md:2:', json.loads(result.stderr)['error'])
                        with sqlite3.connect(self.cache) as db:
                            self.assertEqual(db.execute('SELECT count(*) FROM files').fetchone()[0], 0)

    def test_malformed_dates_in_prose_and_non_task_blocks(self):
        text = '- TODO discuss SCHEDULED: <>\n  discuss DEADLINE: <2026-02-30>\n  - child\n    SCHEDULED: <>\n- note\n  DEADLINE: <>\n'
        tasks = parse(text, 'g', 'pages/a.md')
        self.assertEqual(tasks[0]['content'], 'discuss SCHEDULED: <>\ndiscuss DEADLINE: <2026-02-30>')
        self.assertIsNone(tasks[0]['scheduled'])
        self.assertIsNone(tasks[0]['deadline'])

    def test_previous_parser_cache_upgrade(self):
        for version in (1, 2, 4, 5):
            with self.subTest(version=version):
                relative = 'journals/2026_10_31.md'
                self.write(relative, '- Parent\n\t- TODO original\n\t  full instructions\n\t  SCHEDULED: <2026-10-31> DEADLINE: <2026-11-02>')
                metadata = (self.graph / relative).stat()
                old = dict(id='old-parser-id', content='original', status='TODO', priority=None,
                           scheduled=None, deadline=None, graph=str(self.graph), source_file=relative,
                           source_page='2026_10_31', journal_date='2026-10-31',
                           block_location={'line': 2}, block_uuid=None, block_reference_status='missing')
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
        payloads = ['{', '{}', '[null]', json.dumps([dict(valid, journal_date=None)])]
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

    def test_parser_vocabulary_survives_cache(self):
        from logseq_hud_do.backend import STATUSES, PRIORITIES
        self.write('pages/a.md', '\n'.join(
            f'- {status} ' + (f'[#{priority}] ' if priority else '') +
            'task\n  SCHEDULED: <2026-10-31>'
            for status in STATUSES for priority in (*PRIORITIES, None)))
        cold, stats = self.scan()
        self.assertEqual(stats['parsed'], 1)
        self.assertEqual(len(cold['today']), len(STATUSES) * (len(PRIORITIES) + 1))
        warm, stats = self.scan()
        self.assertEqual(stats['parsed'], 0)
        self.assertEqual(stats['reused'], 1)
        self.assertEqual(warm, cold)

    def test_cache_vocabulary_tracks_parser_owner(self):
        from logseq_hud_do import backend
        record = parse('- TODO task', str(self.graph), 'pages/a.md')[0]
        for field, owner, added in [('status', 'STATUSES', 'WAITING'),
                                     ('priority', 'PRIORITIES', 'D')]:
            values = getattr(backend, owner)
            for value in (*values, added, None, ''):
                candidate = dict(record, **{field: value})
                payload = json.dumps([candidate])
                with self.subTest(field=field, value=value):
                    expected = value in values or (field == 'priority' and value is None)
                    self.assertEqual(backend.cached_records(payload, str(self.graph), 'pages/a.md') is not None, expected)
                    with patch.object(backend, owner, (*values, added)):
                        if value == added:
                            self.assertIsNotNone(backend.cached_records(payload, str(self.graph), 'pages/a.md'))
                    if value in values:
                        with patch.object(backend, owner, tuple(v for v in values if v != value)):
                            self.assertIsNone(backend.cached_records(payload, str(self.graph), 'pages/a.md'))
            candidate = dict(record)
            del candidate[field]
            self.assertIsNone(backend.cached_records(json.dumps([candidate]), str(self.graph), 'pages/a.md'))

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
            self.assertEqual([t['deep_link'] for t in result['today']], [f'logseq://graph/graph?block-id={identifier}', 'logseq://graph/graph?page=Oct+31st%2C+2026'])

    def test_deep_links_encode_graph_and_page_without_display_alias(self):
        graph = self.root / 'My Graph & notes'
        (graph / 'pages').mkdir(parents=True)
        (graph / 'pages' / 'A & B.md').write_text('- TODO task\n  SCHEDULED: <2026-10-31 Sat>')
        for _ in range(2):
            result, _ = scan([(graph, 'Display alias')], self.cache, today=TODAY)
            task = result['today'][0]
            self.assertEqual(task['graph'], 'Display alias')
            self.assertEqual(task['deep_link'], 'logseq://graph/My%20Graph%20%26%20notes?page=A+%26+B')

    def test_og_page_resolution_examples(self):
        examples = [
            ('pages/Work___Projects.md', '- TODO task', 'Work/Projects', 'Work%2FProjects'),
            ('pages/A%3F B%23 C%25.md', '- TODO task', 'A? B# C%', 'A%3F+B%23+C%25'),
            ('pages/filename.md', 'title:: Real & title\n- TODO task', 'Real & title', 'Real+%26+title'),
        ]
        for relative, text, page, encoded in examples:
            with self.subTest(relative=relative):
                self.write(relative, text + '\n  SCHEDULED: <2026-10-31 Sat>')
                for _ in range(2):
                    result, diagnostics = self.scan()
                    task = next(t for t in result['today'] if t['source_file'] == relative)
                    self.assertEqual(task['source_page'], page)
                    self.assertEqual(task['deep_link'], 'logseq://graph/graph?page=' + encoded)
                    self.assertTrue(diagnostics['navigation'])

    def test_invalid_block_reference_falls_back_without_using_task_hash(self):
        self.write('journals/2026_10_31.md', '- TODO task\n  id:: not-a-uuid')
        for _ in range(2):
            result, diagnostics = self.scan()
            task = result['today'][0]
            self.assertIsNone(task['block_uuid'])
            self.assertEqual(task['deep_link'], 'logseq://graph/graph?page=Oct+31st%2C+2026')
            self.assertEqual(diagnostics['navigation'][0]['block_reference_status'], 'invalid')

    def test_custom_journal_config_transitions(self):
        (self.graph / 'logseq').mkdir()
        self.write('journals/2026_11_03.md', '- TODO fallback\n  id:: invalid\n- TODO block\n  id:: 12345678-1234-1234-1234-123456789abc')
        self.write('journals/2026_11_04.md', 'title:: Explicit title\n- TODO explicit\n  SCHEDULED: <2026-11-03>')
        self.write('pages/Test page.md', '- TODO ordinary\n  SCHEDULED: <2026-11-03>')
        for setting, title, encoded in [
                (None, 'Nov 3rd, 2026', 'Nov+3rd%2C+2026'),
                ('yyyy-MM-dd, EEE', '2026-11-03, Tue', '2026-11-03%2C%20Tue'),
                (None, 'Nov 3rd, 2026', 'Nov+3rd%2C+2026'),
                ('yyyy-MM-dd, EEE', '2026-11-03, Tue', '2026-11-03%2C%20Tue')]:
            self.write('logseq/config.edn', '{}' if setting is None else
                       '{:journal/page-title-format ' + json.dumps(setting) + '}')
            for repeat in range(2):
                before = self.cache.read_bytes() if self.cache.exists() else None
                result, stats = scan([(self.graph, 'Work')], self.cache, today=dt.date(2026, 11, 3))
                if before is not None:
                    self.assertEqual(stats['parsed'], 0)
                    self.assertEqual(self.cache.read_bytes(), before)
                by_content = {task['content']: task for task in result['today']}
                self.assertEqual(by_content['fallback']['source_page'], title)
                self.assertEqual(by_content['fallback']['deep_link'], 'logseq://graph/graph?page=' + encoded)
                self.assertEqual(by_content['block']['deep_link'], 'logseq://graph/graph?block-id=12345678-1234-1234-1234-123456789abc')
                self.assertEqual(by_content['ordinary']['deep_link'], 'logseq://graph/graph?page=Test+page')
                self.assertEqual(by_content['explicit']['deep_link'], 'logseq://graph/graph?page=Explicit+title')
                for task in result['today']:
                    self.assertNotIn('_journal_fallback', task)
                self.assertEqual(stats['navigation'][0]['page'], title)
                self.assertEqual(stats['navigation'][0]['deep_link'], by_content['fallback']['deep_link'])

    def test_supported_journal_title_inventory(self):
        from urllib.parse import parse_qs, urlsplit
        (self.graph / 'logseq').mkdir()
        self.write('journals/2026_11_03.md', '- TODO journal')
        cases = {
            'MMM do, yyyy': 'Nov 3rd, 2026',
            'yyyy-MM-dd, EEE': '2026-11-03, Tue',
            'MM/dd/yyyy': '11/03/2026', 'MM-dd-yyyy': '11-03-2026',
            'MM_dd_yyyy': '11_03_2026', 'yyyy/MM/dd': '2026/11/03',
            'yyyy-MM-dd': '2026-11-03', 'yyyy_MM_dd': '2026_11_03',
            'yyyy年MM月dd日': '2026年11月03日',
        }
        for prefix, weekday in [('E', 'Tue'), ('EEE', 'Tue'), ('EEEE', 'Tuesday')]:
            for date, expected in [('MM/dd/yyyy', '11/03/2026'), ('yyyy/MM/dd', '2026/11/03')]:
                cases[prefix + ', ' + date] = weekday + ', ' + expected
        for pattern, expected in cases.items():
            with self.subTest(pattern=pattern):
                self.write('logseq/config.edn', '{:journal/page-title-format ' + json.dumps(pattern) + '}')
                for _ in range(2):
                    before = self.cache.read_bytes() if self.cache.exists() else None
                    result, stats = scan([(self.graph, None)], self.cache, today=dt.date(2026, 11, 3))
                    task = result['today'][0]
                    self.assertEqual(task['source_page'], expected)
                    self.assertEqual(parse_qs(urlsplit(task['deep_link']).query)['page'], [expected])
                    if before is not None:
                        self.assertEqual(stats['parsed'], 0)
                        self.assertEqual(self.cache.read_bytes(), before)

    def test_supported_journal_titles_preserve_year_padding(self):
        from urllib.parse import parse_qs, urlsplit
        (self.graph / 'logseq').mkdir()
        self.write('journals/0999_11_03.md', '- TODO journal\n  SCHEDULED: <2026-11-03>')
        cases = {
            'MMM do, yyyy': 'Nov 3rd, 0999',
            'yyyy-MM-dd, EEE': '0999-11-03, Sun',
            'MM/dd/yyyy': '11/03/0999', 'MM-dd-yyyy': '11-03-0999',
            'MM_dd_yyyy': '11_03_0999', 'yyyy/MM/dd': '0999/11/03',
            'yyyy-MM-dd': '0999-11-03', 'yyyy_MM_dd': '0999_11_03',
            'yyyy年MM月dd日': '0999年11月03日',
        }
        for prefix, weekday in [('E', 'Sun'), ('EEE', 'Sun'), ('EEEE', 'Sunday')]:
            for date, expected in [('MM/dd/yyyy', '11/03/0999'), ('yyyy/MM/dd', '0999/11/03')]:
                cases[prefix + ', ' + date] = weekday + ', ' + expected
        for pattern, expected in cases.items():
            with self.subTest(pattern=pattern):
                self.write('logseq/config.edn', '{:journal/page-title-format ' + json.dumps(pattern) + '}')
                for _ in range(2):
                    before = self.cache.read_bytes() if self.cache.exists() else None
                    result, stats = scan([(self.graph, None)], self.cache, today=dt.date(2026, 11, 3))
                    task = result['today'][0]
                    self.assertEqual(task['source_page'], expected)
                    self.assertEqual(parse_qs(urlsplit(task['deep_link']).query)['page'], [expected])
                    if before is not None:
                        self.assertEqual(stats['parsed'], 0)
                        self.assertEqual(self.cache.read_bytes(), before)

    def test_ordinal_journal_days(self):
        from logseq_hud_do.journal_config import journal_title, DEFAULT_TITLE_FORMAT
        for day, suffix in [(1, 'st'), (2, 'nd'), (3, 'rd'), (11, 'th'), (12, 'th'),
                            (13, 'th'), (21, 'st'), (22, 'nd'), (23, 'rd'), (31, 'st')]:
            self.assertEqual(journal_title(dt.date(2026, 10, day), DEFAULT_TITLE_FORMAT),
                             f'Oct {day}{suffix}, 2026')

    def test_configured_journal_filenames(self):
        (self.graph / 'logseq').mkdir()
        self.write('journals/11-03-2026.md', '- TODO journal')
        for title in ['yyyy-MM-dd', 'MMM do, yyyy']:
            self.write('logseq/config.edn',
                       '{:journal/file-name-format "MM-dd-yyyy" :journal/page-title-format "' + title + '"}')
            result, stats = scan([(self.graph, None)], self.cache, today=dt.date(2026, 11, 3))
            self.assertEqual(result['today'][0]['source_page'],
                             '2026-11-03' if title == 'yyyy-MM-dd' else 'Nov 3rd, 2026')
        self.assertEqual(stats['parsed'], 0)

    def test_task_free_mismatched_journals_preserve_other_tasks(self):
        from logseq_hud_do.journal_config import DATE_FORMATS
        (self.graph / 'logseq').mkdir()
        self.write('pages/Regular.md', '- TODO regular\n  SCHEDULED: <2026-11-03>')
        other = self.root / 'other'
        (other / 'pages').mkdir(parents=True)
        (other / 'pages/Other.md').write_text('- TODO other\n  SCHEDULED: <2026-11-03>')
        for index, text in enumerate(('', '- ordinary note', '- DONE completed',
                                       '- ```\n  - TODO example\n  ```')):
            self.write(f'journals/old-{index}.md', text)
        for index, (pattern, date_format) in enumerate(DATE_FORMATS.items()):
            with self.subTest(pattern=pattern):
                matching = self.graph / 'journals' / (dt.date(2026, 11, 3).strftime(date_format) + '.md')
                matching.parent.mkdir(parents=True, exist_ok=True)
                matching.write_text('- TODO journal')
                self.write('logseq/config.edn', '{:journal/file-name-format ' + json.dumps(pattern) + '}')
                cache = self.root / (str(index) + '.sqlite')
                for repeat in range(2):
                    result, stats = scan([(self.graph, None), (other, None)], cache,
                                         today=dt.date(2026, 11, 3))
                    self.assertEqual({task['content'] for task in result['today']},
                                     {'regular', 'other', 'journal'})
                    self.assertEqual(len(stats['navigation']), 3)
                    self.assertEqual(stats['parsed'], 0 if repeat else 7)
                    self.assertEqual(stats['reused'], 7 if repeat else 0)
                matching.unlink()

    def test_filename_format_change_rejects_cached_task_mismatch(self):
        (self.graph / 'logseq').mkdir()
        self.write('journals/11-03-2026.md', '- TODO journal')
        self.write('logseq/config.edn', '{:journal/file-name-format "MM-dd-yyyy"}')
        result, stats = scan([(self.graph, None)], self.cache, today=dt.date(2026, 11, 3))
        self.assertEqual(result['today'][0]['source_page'], 'Nov 3rd, 2026')
        self.assertEqual(stats['parsed'], 1)
        before = self.cache.read_bytes()
        self.write('logseq/config.edn', '{:journal/file-name-format "yyyy-MM-dd"}')
        with patch('logseq_hud_do.backend.parse', side_effect=AssertionError('must reuse extraction')):
            with self.assertRaisesRegex(ValueError, 'invalid journal filename for yyyy-MM-dd'):
                scan([(self.graph, None)], self.cache, today=dt.date(2026, 11, 3))
        self.assertEqual(self.cache.read_bytes(), before)

    def test_explicit_title_configured_journal_is_today(self):
        (self.graph / 'logseq').mkdir()
        self.write('logseq/config.edn', '{:journal/file-name-format "MM-dd-yyyy"}')
        self.write('journals/11-03-2026.md', 'title:: Named journal\n- TODO journal')
        for repeat in range(2):
            result, stats = scan([(self.graph, None)], self.cache, today=dt.date(2026, 11, 3))
            self.assertEqual(len(result['today']), 1)
            task = result['today'][0]
            self.assertIsNone(task['scheduled'])
            self.assertEqual(task['journal_date'], '2026-11-03')
            self.assertEqual(task['source_page'], 'Named journal')
            self.assertEqual(task['deep_link'], 'logseq://graph/graph?page=Named+journal')
            self.assertEqual(stats['parsed'], 0 if repeat else 1)

    def test_invalid_configured_formats_fail_scan(self):
        (self.graph / 'logseq').mkdir()
        self.write('journals/2026_10_31.md', '- TODO journal')
        self.write('pages/a.md', '- TODO page')
        for key in ['page-title-format', 'file-name-format']:
            for value in ['"yyyy"', '""', '42']:
                with self.subTest(key=key, value=value):
                    self.write('logseq/config.edn', '{:journal/' + key + ' ' + value + '}')
                    with self.assertRaises((ValueError, TypeError)):
                        self.scan()
        self.write('logseq/config.edn', '{:journal/file-name-format "MM-dd-yyyy"}')
        with self.assertRaisesRegex(ValueError, 'invalid journal filename'):
            self.scan()

    def test_journal_config_errors_fail_cli_on_cold_and_warm_cache(self):
        from logseq_hud_do.journal_config import journal_format
        (self.graph / 'logseq').mkdir()
        self.write('journals/2026_10_31.md', '- TODO journal')
        malformed = ['}', '"unterminated}', '"bad\\q"}',
                     '"yyyy_MM_dd"', '["yyyy_MM_dd"}',
                     '"yyyy_MM_dd"} {}', '"yyyy_MM_dd"} #_']
        unsupported = ['"yyyy"}', '""}', '42}', 'nil}', '["yyyy_MM_dd"]}']
        for key in (':journal/page-title-format', ':journal/file-name-format'):
            for tail in malformed + unsupported:
                text = '{' + key + ' ' + tail
                error = ('logseq/config.edn: invalid configuration syntax'
                         if tail in malformed else 'unsupported ' + key[1:])
                with self.subTest(key=key, text=text):
                    if tail in malformed:
                        with self.assertRaisesRegex(ValueError, error):
                            journal_format(text, key)
                    else:
                        self.assertIsNotNone(journal_format(text, key))
                for warm in (False, True):
                    with self.subTest(key=key, text=text, warm=warm):
                        self.cache.unlink(missing_ok=True)
                        self.write('logseq/config.edn', '{}')
                        if warm:
                            self.scan()
                        before = self.cache.read_bytes() if warm else None
                        self.write('logseq/config.edn', text)
                        completed = subprocess.run(
                            [sys.executable, '-m', 'logseq_hud_do', '--graph', str(self.graph),
                             '--cache', str(self.cache), '--diagnostics'],
                            capture_output=True, text=True, timeout=5)
                        self.assertEqual(completed.returncode, 1)
                        self.assertEqual(completed.stdout, '')
                        self.assertIn(error, json.loads(completed.stderr)['error'])
                        if warm:
                            self.assertEqual(self.cache.read_bytes(), before)
                        self.write('logseq/config.edn', '{}')
                        result, stats = self.scan()
                        self.assertEqual(stats['parsed'], 0 if warm else 1)
                        self.assertEqual(stats['reused'], 1 if warm else 0)
                        self.assertEqual(result['today'][0]['deep_link'],
                                         'logseq://graph/graph?page=Oct+31st%2C+2026')

    def test_missing_journal_settings_keep_defaults_on_cold_and_warm_cache(self):
        from logseq_hud_do.journal_config import journal_format
        (self.graph / 'logseq').mkdir()
        self.write('journals/2026_10_31.md', '- TODO journal')
        config = self.graph / 'logseq/config.edn'
        for text in (None, '{}', '{:other [1 2]}',
                     '{:journal/page-title-format "MMM do, yyyy"}',
                     '{:journal/file-name-format "yyyy_MM_dd"}'):
            with self.subTest(text=text):
                self.cache.unlink(missing_ok=True)
                config.unlink(missing_ok=True)
                if text is not None:
                    config.write_text(text)
                    for key in (':journal/page-title-format', ':journal/file-name-format'):
                        if key not in text:
                            self.assertIsNone(journal_format(text, key))
                for warm in (False, True):
                    result, stats = self.scan()
                    self.assertEqual(stats['parsed'], 0 if warm else 1)
                    self.assertEqual(stats['reused'], 1 if warm else 0)
                    task, = result['today']
                    self.assertEqual(task['source_page'], 'Oct 31st, 2026')
                    self.assertEqual(task['deep_link'],
                                     'logseq://graph/graph?page=Oct+31st%2C+2026')

    def test_custom_journal_weekdays_and_graph_isolation(self):
        (self.graph / 'logseq').mkdir()
        self.write('logseq/config.edn', '{:journal/page-title-format "yyyy-MM-dd, EEE"}')
        other = self.root / 'other'
        (other / 'journals').mkdir(parents=True)
        for offset, weekday in enumerate(('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')):
            date = dt.date(2026, 11, 2) + dt.timedelta(days=offset)
            relative = 'journals/' + date.strftime('%Y_%m_%d') + '.md'
            self.write(relative, '- TODO task')
            (other / relative).write_text('- TODO other')
            for _ in range(2):
                result, _ = scan([(self.graph, None), (other, None)], self.cache, today=date)
                tasks = {t['content']: t for t in result['today']}
                self.assertEqual(tasks['task']['source_page'], f'{date.isoformat()}, {weekday}')
                self.assertTrue(tasks['other']['source_page'].startswith('Nov '))

    def test_multiline_config_navigation(self):
        (self.graph / 'logseq').mkdir()
        self.write('journals/2026_11_03.md', '- TODO task')
        multiline = '"first\nsecond"'
        forms = [f'{multiline} :value', f':macro {multiline}',
                 f':vector [{multiline}]', f':list ({multiline})',
                 f':set #{{{multiline}}}', f':tag #example {multiline}',
                 f'#_ {multiline}']
        for form in forms:
            with self.subTest(form=form):
                self.write('logseq/config.edn', '{' + form +
                           ' :journal/page-title-format "yyyy-MM-dd, EEE"}')
                for _ in range(2):
                    result, _ = scan([(self.graph, None)], self.cache, today=dt.date(2026, 11, 3))
                    self.assertEqual(result['today'][0]['deep_link'],
                                     'logseq://graph/graph?page=2026-11-03%2C%20Tue')

    def test_deep_journal_config_reports_cli_error(self):
        from logseq_hud_do.journal_config import TITLE_FORMATS
        (self.graph / 'logseq').mkdir()
        self.write('journals/2026_10_31.md', '- TODO task')
        settings = [(':journal/page-title-format', json.dumps(pattern))
                    for pattern in sorted(TITLE_FORMATS)]
        settings += [(':journal/page-title-format', '"unsupported"'),
                     (':journal/file-name-format', '"unsupported"')]
        nested_forms = ['[' * 2000 + '0' + ']' * 2000,
                        '#tag ' * 2000 + '0', '#_ ' * 2000 + '0 0']
        for key, value in settings:
            for nested in nested_forms:
                for warm in (False, True):
                    with self.subTest(key=key, value=value, form=nested[:8], warm=warm):
                        self.cache.unlink(missing_ok=True)
                        self.write('logseq/config.edn', '{}')
                        if warm:
                            self.scan()
                        self.write('logseq/config.edn',
                                   '{' + key + ' ' + value + ' :other ' + nested + '}')
                        completed = subprocess.run(
                            [sys.executable, '-m', 'logseq_hud_do', '--graph', str(self.graph),
                             '--cache', str(self.cache)], capture_output=True, text=True, timeout=5)
                        self.assertEqual(completed.returncode, 1)
                        self.assertEqual(completed.stdout, '')
                        self.assertIn('logseq/config.edn exceeds supported nesting depth',
                                      json.loads(completed.stderr)['error'])

    def test_trailing_journal_config_discards(self):
        from logseq_hud_do.journal_config import journal_format
        settings = {':journal/page-title-format': 'yyyy-MM-dd, EEE',
                    ':journal/file-name-format': 'MM-dd-yyyy'}
        config = '{' + ' '.join(key + ' ' + json.dumps(value)
                                for key, value in settings.items()) + '}'
        suffixes = ['', ' #_ :ignored', ' #_ {:ignored [1 2]}',
                    ' #_ #_ :inner :outer', ' #_ :one #_ [:two] ; comment']
        for suffix in suffixes:
            for key, value in settings.items():
                with self.subTest(suffix=suffix, key=key):
                    self.assertEqual(journal_format(config + suffix, key), value)
        for suffix in [' :extra', ' {}', ' #_', ' #_ [', ' #_ #_ :inner',
                       ' #_ :ignored :extra', ' #_ :ignored #_']:
            for key in settings:
                with self.subTest(suffix=suffix, key=key):
                    with self.assertRaisesRegex(ValueError, 'logseq/config.edn: invalid configuration syntax'):
                        journal_format(config + suffix, key)
        (self.graph / 'logseq').mkdir()
        self.write('journals/11-03-2026.md', '- TODO journal')
        for index, suffix in enumerate(suffixes):
            self.write('logseq/config.edn', config + suffix)
            before = self.cache.read_bytes() if self.cache.exists() else None
            result, stats = scan([(self.graph, None)], self.cache, today=dt.date(2026, 11, 3))
            task, = result['today']
            self.assertEqual(task['journal_date'], '2026-11-03')
            self.assertEqual(task['source_page'], '2026-11-03, Tue')
            self.assertEqual(task['deep_link'],
                             'logseq://graph/graph?page=2026-11-03%2C%20Tue')
            self.assertEqual(stats['parsed'], 0 if index else 1)
            if before is not None:
                self.assertEqual(self.cache.read_bytes(), before)

    def test_journal_config_input_boundaries(self):
        from logseq_hud_do.journal_config import journal_format
        key = ':journal/page-title-format'
        value = '"yyyy-MM-dd, EEE"'
        for text in [f'{{; {key} "wrong"\n {key} {value}}}',
                     '{:other "escaped \\" quote" ' + key + ' ' + value + '}',
                     f'{{:nested {{{key} "wrong"}} {key} {value}}}',
                     f'{{#_ #_ :a :b {key} {value}}}',
                     f'{{:tag #inst #_ :ignored "2026-11-03" {key} {value}}}',
                     f'{{:set #{{:one}} :tag #inst "2026-11-03" {key} {value}}}',
                     f'{{#_ {key} #_ "wrong" {key} {value}}}',
                     '{' + key + ' "yyyy-MM-dd, \u0045EE"}']:
            with self.subTest(text=text):
                self.assertEqual(journal_format(text), 'yyyy-MM-dd, EEE')
        for text in ['{}', f'{{:nested {{{key} {value}}}}}',
                     f'{{; {key} {value}\n}}']:
            with self.subTest(text=text):
                self.assertIsNone(journal_format(text))
        for text in ['', '[]', 'nil', f'{{{key} {value}',
                     f'{{{key}}}', f'{{{key} "bad\\q"}}',
                     f'{{{key} {value}}} trailing']:
            with self.subTest(text=text):
                with self.assertRaisesRegex(ValueError, 'logseq/config.edn: invalid configuration syntax'):
                    journal_format(text)
        self.write('journals/2026_10_31.md', '- TODO task')
        (self.graph / 'logseq').mkdir()
        config = self.graph / 'logseq/config.edn'
        outside = self.root / 'config.edn'
        outside.write_text(f'{{{key} {value}}}')
        for _ in range(2):
            self.assertEqual(self.scan()[0]['today'][0]['source_page'], 'Oct 31st, 2026')
        config.symlink_to(outside)
        with self.assertRaises(OSError):
            self.scan()
        config.unlink()
        config.write_bytes(b'\xff')
        with self.assertRaises(UnicodeError):
            self.scan()
        completed = subprocess.run([sys.executable, '-m', 'logseq_hud_do', '--graph', str(self.graph),
                                    '--cache', str(self.cache)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, '')
        self.assertIn('error', json.loads(completed.stderr))
        config.unlink()
        config.mkdir()
        with self.assertRaises(OSError):
            self.scan()
        config.rmdir()
        for error in [PermissionError('denied'), OSError('read failed')]:
            with self.subTest(error=error), patch('logseq_hud_do.backend.open_source', side_effect=error):
                with self.assertRaises(OSError):
                    self.scan()
        (self.graph / 'logseq').rmdir()
        (self.graph / 'logseq').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.scan()

    def test_nonregular_sources_do_not_block(self):
        self.write('journals/2026_10_31.md', '- TODO task')
        (self.graph / 'logseq').mkdir()
        config = self.graph / 'logseq/config.edn'
        os.mkfifo(config)
        completed = subprocess.run([sys.executable, '-m', 'logseq_hud_do', '--graph', str(self.graph), '--cache', str(self.cache)],
                       capture_output=True, text=True, timeout=3)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, '')
        self.assertIn('error', json.loads(completed.stderr))
        from logseq_hud_do.backend import open_source
        os.mkfifo(self.graph / 'pages/fifo.md')
        for relative in ['logseq/config.edn', 'pages/fifo.md', 'pages']:
            with self.subTest(relative=relative), self.assertRaises(OSError):
                open_source(self.graph, relative)

    def test_inconsistent_journal_cache_recovers_with_other_graph(self):
        self.write('journals/2026_10_31.md', '- TODO journal')
        (self.graph / 'logseq').mkdir()
        (self.graph / 'logseq/config.edn').write_text('{:journal/page-title-format "yyyy-MM-dd, EEE"}')
        other = self.root / 'other'
        (other / 'pages').mkdir(parents=True)
        (other / 'pages/a.md').write_text('- TODO other\n  SCHEDULED: <2026-10-31>')
        graphs = [(self.graph, None), (other, None)]
        expected, _ = scan(graphs, self.cache, today=TODAY)
        with sqlite3.connect(self.cache) as db:
            payload = json.loads(db.execute('SELECT tasks FROM files WHERE graph=?', (str(self.graph),)).fetchone()[0])
            payload[0]['journal_date'] = None
            db.execute('UPDATE files SET tasks=? WHERE graph=?', (json.dumps(payload), str(self.graph)))
        actual, stats = scan(graphs, self.cache, today=TODAY)
        self.assertEqual(actual, expected)
        self.assertEqual(stats['parsed'], 1)
        self.assertEqual(stats['reused'], 1)

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


class BlockContextTests(unittest.TestCase):
    def test_context_empty_blocks_preserve_ownership(self):
        for unit in ('\t', '  ', '    '):
            with self.subTest(indent=repr(unit)):
                text = ('- Root\n' + unit + '-\n' + unit * 2 + '-\n'
                        + unit * 3 + '- TODO target\n' + unit * 3 + '  prose\n'
                        + unit * 4 + '-\n' + unit * 5 + '- Grandchild\n'
                        + unit * 4 + '-  \n' + unit * 5 + '- Another grandchild\n')
                relative = self.write('pages/empty.md', text)
                task = parse(text, str(self.graph), relative)[0]
                context = block_context(self.graph, relative, task['id'])
                self.assertEqual([p['content'] for p in context['parent']], ['Root', '', ''])
                self.assertEqual(context['current']['content'], 'TODO target\nprose')
                self.assertEqual([c['content'] for c in context['children']], ['', ''])
                self.assertEqual([c['block_location']['line'] for c in context['children']], [6, 8])

    def test_context_preserves_owned_fences_as_literal_text(self):
        for fence in ('```', '~~~~'):
            for closed in (True, False):
                with self.subTest(fence=fence, closed=closed):
                    lines = ['- TODO target', '  before', '  ' + fence + 'python',
                             '  - code bullet', '    indented', '  \tcode\twith tabs  ',
                             '  id:: 11111111-1111-4111-8111-111111111111',
                             '  # code heading', '  ```not a closer', '  - TODO still code']
                    expected = ['TODO target', 'before', fence + 'python', '- code bullet',
                                '  indented', '\tcode\twith tabs  ', 'id:: 11111111-1111-4111-8111-111111111111',
                                '# code heading', '```not a closer', '- TODO still code']
                    if closed:
                        lines += ['  ' + fence, '  after', '  - Real child']
                        expected += [fence, 'after']
                    text = '\n'.join(lines) + '\n'
                    relative = self.write('pages/fence.md', text)
                    task = parse(text, str(self.graph), relative)[0]
                    context = block_context(self.graph, relative, task['id'])
                    self.assertEqual(context['current']['content'], '\n'.join(expected))
                    self.assertIsNone(context['current']['uuid'])
                    self.assertEqual([c['content'] for c in context['children']], ['Real child'] if closed else [])

    def test_context_fences_in_ancestors_and_children(self):
        text = ('- Parent\n  ```text\n  - literal\n  ```\n'
                '\t- TODO target\n\t\t- ~~~sh\n\t\t  echo literal\n\t\t  ~~~\n'
                '\t\t- Sibling\n')
        relative = self.write('pages/owners.md', text)
        task = parse(text, str(self.graph), relative)[0]
        context = block_context(self.graph, relative, task['id'])
        self.assertEqual([p['content'] for p in context['parent']], ['Parent\n```text\n- literal\n```'])
        self.assertEqual([c['content'] for c in context['children']], ['~~~sh\necho literal\n~~~', 'Sibling'])

    def test_context_retains_unbulleted_heading_ancestor(self):
        text = (ROOT_DIR / 'tests/fixtures/block-context-root-heading.md').read_text()
        for relative in ('pages/context.md', 'journals/2026_01_02.md'):
            with self.subTest(relative=relative):
                (self.graph / relative).parent.mkdir(parents=True, exist_ok=True)
                self.write(relative, text)
                task = parse(text, str(self.graph), relative)[0]
                context = block_context(self.graph, relative, task['id'])
                self.assertEqual([p['content'] for p in context['parent']], ['### Root heading', '**Section**'])
                self.assertEqual(context['parent'][0]['uuid'], '11111111-1111-4111-8111-111111111111')
                self.assertEqual(context['current']['content'], 'TODO Selected task\nSCHEDULED: <2026-01-02 Fri>')
                self.assertEqual([c['content'] for c in context['children']], ['Direct child'])

    def test_context_three_parents_with_heading_properties_and_fences(self):
        for unit in ('\t', '  '):
            for with_uuid in (False, True):
                with self.subTest(unit=repr(unit), with_uuid=with_uuid):
                    identifier = '22222222-2222-4222-8222-222222222222'
                    text = ('### Root heading\nid:: 11111111-1111-4111-8111-111111111111\n'
                            'type:: example\nrelay-id:: fixture\n'
                            + unit + '- Section\n'
                            + unit * 2 + '- Branch\n'
                            + unit * 3 + '- TODO Selected\n'
                            + (unit * 3 + '  id:: ' + identifier + '\n' if with_uuid else '')
                            + unit * 3 + '  continuation\n'
                            + unit * 4 + '- Direct child\n'
                            + unit * 5 + '- Grandchild\n'
                            + unit * 4 + '- Another child\n'
                            '### Next heading\n'
                            '```\n### Not a heading block\n- Not a child\n```\n'
                            + unit + '- Next branch\n')
                    relative = self.write('pages/deep.md', text)
                    task = parse(text, str(self.graph), relative)[0]
                    for target in ([task['id'], identifier] if with_uuid else [task['id']]):
                        context = block_context(self.graph, relative, target)
                        self.assertEqual([p['content'] for p in context['parent']], ['### Root heading', 'Section', 'Branch'])
                        self.assertEqual(context['current']['content'], 'TODO Selected\ncontinuation')
                        self.assertEqual([c['content'] for c in context['children']], ['Direct child', 'Another child'])
                    next_branch = next(r for r in blocks(text) if r['first'] == 'Next branch')
                    self.assertEqual(blocks(text)[next_branch['parent']]['first'], '### Next heading')

    def test_context_ancestor_continuation_does_not_clear_parent_chain(self):
        text = ('- Project\n'
                '\t- Backend\n'
                '\t\t- API\n'
                '\t\t\t- TODO Earlier task\n'
                '\t\t\t\t- Earlier child\n'
                '\t\t  API continuation\n'
                '\t\t\t- TODO Selected task\n'
                '\t\t\t\t- Direct child\n')
        relative = self.write('pages/continuation.md', text)
        task = parse(text, str(self.graph), relative)[1]
        context = block_context(self.graph, relative, task['id'])
        self.assertEqual([p['content'] for p in context['parent']],
                         ['Project', 'Backend', 'API\nAPI continuation'])
        self.assertEqual([c['content'] for c in context['children']], ['Direct child'])

    def test_context_source_boundary(self):
        identifier = '5a3e0b2c-1111-2222-3333-444455556666'
        (self.root / 'outside.md').write_text(self.FIXTURE)
        self.write('outside.md', self.FIXTURE)
        (self.graph / 'unsupported').mkdir()
        self.write('unsupported/task.md', self.FIXTURE)
        self.write('pages/task.txt', self.FIXTURE)
        for relative in ('../outside.md', str(self.root / 'outside.md'),
                         'pages/../outside.md', 'unsupported/task.md',
                         'pages/task.txt', '', 'pages'):
            with self.subTest(relative=relative), self.assertRaisesRegex(ValueError, 'source path'):
                block_context(self.graph, relative, identifier)

    def test_context_valid_roots_and_symlink_components(self):
        identifier = '5a3e0b2c-1111-2222-3333-444455556666'
        for relative in ('pages/nested/task.md', 'journals/2026_11_06.md'):
            (self.graph / relative).parent.mkdir(parents=True, exist_ok=True)
            self.write(relative, self.FIXTURE)
            self.assertEqual(block_context(self.graph, relative, identifier)['current']['uuid'], identifier)
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'task.md').write_text(self.FIXTURE)
        (self.graph / 'pages/escape').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            block_context(self.graph, 'pages/escape/task.md', identifier)
        (self.graph / 'journals').rename(self.graph / 'old-journals')
        (self.graph / 'journals').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            block_context(self.graph, 'journals/task.md', identifier)

    def test_cli_invalid_source_is_controlled(self):
        result = subprocess.run(
            [sys.executable, '-m', 'logseq_hud_do', f'--graph={self.graph}',
             '--block-context', '../outside.md', 'missing'],
            capture_output=True, text=True, cwd=ROOT_DIR)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('source path', json.loads(result.stderr)['error'])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.graph = self.root / 'graph'
        (self.graph / 'pages').mkdir(parents=True)

    def write(self, relative, text):
        (self.graph / relative).write_text(text)
        return relative

    FIXTURE = (
        '- Project Alpha\n'
        '\t- Milestones\n'
        '\t\t- TODO Ship the thing\n'
        '\t\t  id:: 5a3e0b2c-1111-2222-3333-444455556666\n'
        '\t\t  SCHEDULED: <2026-11-06>\n'
        '\t\t\t- TODO sub item one\n'
        '\t\t\t- DOING sub item two\n'
        '\t\t- a sibling note\n'
        '\t- ```\n'
        '\t  - not a bullet inside fence\n'
        '\t  ```\n'
    )

    def test_blocks_agree_with_parse_on_structure(self):
        # The context walker must see the same task blocks the extractor emits.
        relative = 'pages/project.md'
        records = blocks(self.FIXTURE)
        tasks = parse(self.FIXTURE, 'g', relative)
        import re
        tasklike = re.compile(r'(TODO|DOING)(?:\s+|$)')
        first_lines = [r['first'] for r in records if tasklike.match(r['first'])]
        self.assertEqual(first_lines,
                         ['TODO Ship the thing', 'TODO sub item one', 'DOING sub item two'])
        self.assertEqual(len(tasks), 3)
        # The fence opener is itself a block (matching parse); its inner line is not.
        self.assertIn('```', first_lines_all := [r['first'] for r in records])
        self.assertNotIn('not a bullet inside fence', first_lines_all)

    def test_context_hierarchy_children_and_own_content(self):
        relative = self.write('pages/project.md', self.FIXTURE)
        context = block_context(self.graph, relative,
                                '5a3e0b2c-1111-2222-3333-444455556666', name='Work')
        self.assertEqual(context['graph'], 'Work')
        self.assertEqual(context['source_file'], relative)
        self.assertEqual([p['content'] for p in context['parent']],
                         ['Project Alpha', 'Milestones'])
        # SCHEDULED stays with the owning block, not a child.
        self.assertEqual(context['current']['content'],
                         'TODO Ship the thing\nSCHEDULED: <2026-11-06>')
        self.assertEqual(context['current']['uuid'],
                         '5a3e0b2c-1111-2222-3333-444455556666')
        # Direct children only; the sibling note and fenced bullet are excluded.
        self.assertEqual([c['content'] for c in context['children']],
                         ['TODO sub item one', 'DOING sub item two'])

    def test_context_lookup_by_graph_uuid_and_hash(self):
        relative = self.write('pages/project.md', self.FIXTURE)
        graph_id = str(self.graph)
        for target in (f'{graph_id}:5a3e0b2c-1111-2222-3333-444455556666',):
            context = block_context(self.graph, relative, target)
            self.assertEqual(context['current']['uuid'],
                             '5a3e0b2c-1111-2222-3333-444455556666')
        # A task without id:: is addressable by its backend hash identity.
        hashed = parse(self.FIXTURE, graph_id, relative)
        plain = next(t for t in hashed if t['block_uuid'] is None)
        context = block_context(self.graph, relative, plain['id'])
        # block_context keeps the TODO/DOING marker; parse strips it into status.
        self.assertEqual(context['current']['content'].splitlines()[0],
                         f"{plain['status']} {plain['content'].splitlines()[0]}")

    def test_context_missing_block_raises(self):
        relative = self.write('pages/project.md', self.FIXTURE)
        with self.assertRaisesRegex(ValueError, 'block not found'):
            block_context(self.graph, relative, 'does-not-exist')

    def test_context_refuses_symlinked_source(self):
        target = self.write('pages/real.md', self.FIXTURE)
        link = self.graph / 'pages' / 'link.md'
        link.symlink_to(self.graph / target)
        with self.assertRaises(OSError):
            block_context(self.graph, 'pages/link.md',
                          '5a3e0b2c-1111-2222-3333-444455556666')

    def test_cli_block_context_roundtrip(self):
        relative = self.write('pages/project.md', self.FIXTURE)
        result = subprocess.run(
            [sys.executable, '-m', 'logseq_hud_do', f'--graph={self.graph}',
             '--graph-name=Work', '--block-context', relative,
             '5a3e0b2c-1111-2222-3333-444455556666'],
            capture_output=True, text=True, cwd=ROOT_DIR)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual([c['content'] for c in payload['children']],
                         ['TODO sub item one', 'DOING sub item two'])
        self.assertEqual(payload['current']['uuid'],
                         '5a3e0b2c-1111-2222-3333-444455556666')

    def test_cli_block_context_error_channel(self):
        relative = self.write('pages/project.md', self.FIXTURE)
        result = subprocess.run(
            [sys.executable, '-m', 'logseq_hud_do', f'--graph={self.graph}',
             '--block-context', relative, 'missing'],
            capture_output=True, text=True, cwd=ROOT_DIR)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(json.loads(result.stderr)['error'], 'block not found: missing')

    def test_cli_block_context_rejects_multiple_graphs(self):
        relative = self.write('pages/project.md', self.FIXTURE)
        other = self.root / 'other'
        (other / 'pages').mkdir(parents=True)
        result = subprocess.run(
            [sys.executable, '-m', 'logseq_hud_do', f'--graph={self.graph}',
             f'--graph={other}', '--block-context', relative, 'x'],
            capture_output=True, text=True, cwd=ROOT_DIR)
        self.assertEqual(result.returncode, 1)
        self.assertIn('exactly one', json.loads(result.stderr)['error'])
