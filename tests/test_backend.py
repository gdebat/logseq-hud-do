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
                ('yyyy-MM-dd, EEE', '2026-11-03, Tue', '2026-11-03%2C%20Tue'),
                ('yyyy', 'Nov 3rd, 2026', 'Nov+3rd%2C+2026')]:
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
        for text in ['', '{}', f'{{:nested {{{key} {value}}}}}',
                     f'{{; {key} {value}\n}}', f'{{{key} {value}',
                     f'{{{key}}}', f'{{{key} "bad\\q"}}',
                     f'{{{key} {value}}} trailing']:
            with self.subTest(text=text):
                self.assertIsNone(journal_format(text))
        self.write('journals/2026_10_31.md', '- TODO task')
        (self.graph / 'logseq').mkdir()
        config = self.graph / 'logseq/config.edn'
        outside = self.root / 'config.edn'
        outside.write_text(f'{{{key} {value}}}')
        config.symlink_to(outside)
        self.assertEqual(self.scan()[0]['today'][0]['source_page'], 'Oct 31st, 2026')
        config.unlink()
        config.write_bytes(b'\xff')
        self.assertEqual(self.scan()[0]['today'][0]['source_page'], 'Oct 31st, 2026')
        config.unlink()
        with patch('logseq_hud_do.backend.open_source', side_effect=PermissionError):
            self.assertEqual(self.scan()[0]['today'][0]['source_page'], 'Oct 31st, 2026')
        (self.graph / 'logseq').rmdir()
        (self.graph / 'logseq').symlink_to(self.root, target_is_directory=True)
        self.assertEqual(self.scan()[0]['today'][0]['source_page'], 'Oct 31st, 2026')

    def test_nonregular_sources_do_not_block(self):
        self.write('journals/2026_10_31.md', '- TODO task')
        (self.graph / 'logseq').mkdir()
        config = self.graph / 'logseq/config.edn'
        os.mkfifo(config)
        script = "from pathlib import Path; from logseq_hud_do.backend import scan; import sys; scan([(Path(sys.argv[1]), None)], Path(sys.argv[2]))"
        subprocess.run([sys.executable, '-c', script, str(self.graph), str(self.cache)],
                       check=True, timeout=3)
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
