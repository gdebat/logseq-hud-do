"""Line-oriented extraction and transactional incremental indexing."""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlencode, quote, unquote
import uuid

VERSION = 4
GRAPH_ROOTS = tuple(json.loads(Path(__file__).with_name('graph-roots.json').read_text()))
STATUSES = ('TODO', 'DOING')
PRIORITIES = ('A', 'B', 'C')
BLOCK = re.compile(r'^(\s*)-\s+(.*)$')
TASK = re.compile(r'^(' + '|'.join(map(re.escape, STATUSES)) + r')(?:\s+|$)(.*)')
SCHEDULING_FIELD = re.compile(r'(SCHEDULED|DEADLINE):\s*')
TIMESTAMP = re.compile(r'<([^>]*)>(?:\s+|$)')
PRIORITY = re.compile(r'\[#(' + '|'.join(map(re.escape, PRIORITIES)) + r')\]')
ID = re.compile(r'^\s*id::\s*(.*?)\s*$')


def date_value(value):
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def journal_date(path):
    if Path(path).parts[0] != 'journals':
        return None
    stem = Path(path).stem
    for pattern in ('%Y_%m_%d', '%Y-%m-%d', '%b %d, %Y', '%B %d, %Y'):
        try:
            return dt.datetime.strptime(stem, pattern).date().isoformat()
        except ValueError:
            pass
    return None


def page_name(text, relative):
    for line in text.splitlines():
        if BLOCK.match(line):
            break
        title = re.match(r'^title::\s*(.+?)\s*$', line)
        if title:
            return title[1]
    date = journal_date(relative)
    if date:
        day = dt.date.fromisoformat(date)
        suffix = 'th' if 10 <= day.day % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(day.day % 10, 'th')
        month = ('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec').split()[day.month - 1]
        return f'{month} {day.day}{suffix}, {day.year}'
    return unquote(Path(relative).stem.replace('___', '/'))


def parse(text, graph, relative):
    tasks, stack, occurrences = [], [], {}
    source_page = page_name(text, relative)
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        match = BLOCK.match(line)
        body = match[2] if match else line.strip()
        fence_match = re.match(r'(`{3,}|~{3,})', body)
        if fence is not None:
            if fence_match and fence_match[1][0] == fence[0] and len(fence_match[1]) >= len(fence):
                fence = None
            continue
        if match:
            indent = len(match[1].expandtabs(4))
            while stack and stack[-1][0] >= indent:
                stack.pop()
            task_match = TASK.match(body)
            task = None
            if task_match:
                status, content = task_match.groups()
                priority = PRIORITY.search(content)
                key = status + '\0' + content
                occurrences[key] = occurrences.get(key, 0) + 1
                identity = '\0'.join((graph, relative, key, str(occurrences[key])))
                task = dict(id=hashlib.sha256(identity.encode()).hexdigest(), content=content,
                            status=status, priority=priority[1] if priority else None,
                            scheduled=None, deadline=None, graph=graph, source_file=relative,
                            source_page=source_page, journal_date=journal_date(relative),
                            block_location={'line': number}, block_uuid=None, block_reference_status='missing')
                tasks.append(task)
            stack.append((indent, task))
        elif stack and line.strip() and len(line) - len(line.lstrip()) <= stack[-1][0]:
            stack.clear()
        if fence_match:
            fence = fence_match[1]
            continue
        owner = stack[-1][1] if stack else None
        if owner is not None:
            scheduling = SCHEDULING_FIELD.match(body) if not match else None
            if scheduling:
                remaining = body
                while scheduling:
                    kind = scheduling[1]
                    timestamp = TIMESTAMP.match(remaining, scheduling.end())
                    value = timestamp[1].split()[0] if timestamp and timestamp[1].split() else ''
                    rest = remaining[timestamp.end():] if timestamp else ''
                    next_field = SCHEDULING_FIELD.match(rest)
                    if not date_value(value) or (rest and not next_field):
                        raise ValueError(f'{graph}/{relative}:{number}: invalid {kind} date: {remaining}')
                    owner['scheduled' if kind == 'SCHEDULED' else 'deadline'] = value
                    remaining, scheduling = rest, next_field
            elif not match and not re.match(r'^\w+::', body):
                owner['content'] += '\n' + body
            identifier = ID.match(line)
            if identifier:
                try:
                    owner['block_uuid'] = str(uuid.UUID(identifier[1]))
                    owner['block_reference_status'] = 'valid'
                    owner['id'] = graph + ':' + owner['block_uuid']
                except ValueError:
                    owner['block_reference_status'] = 'invalid'
    return tasks


def discover(graph):
    files = {}
    for name in GRAPH_ROOTS:
        folder = graph / name
        if folder.is_symlink():
            continue
        if not folder.exists():
            continue
        def onerror(error):
            raise error
        for root, dirs, names in os.walk(folder, followlinks=False, onerror=onerror):
            dirs[:] = sorted(d for d in dirs if not (Path(root) / d).is_symlink())
            for name in sorted(names):
                path = Path(root) / name
                if path.suffix.lower() != '.md' or path.is_symlink() or not path.is_file():
                    continue
                stat = path.stat()
                files[path.relative_to(graph).as_posix()] = (stat.st_mtime_ns, stat.st_size)
    return files


def connect(cache):
    connection = sqlite3.connect(cache, timeout=30)
    try:
        if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise sqlite3.DatabaseError('cache integrity check failed')
        connection.execute('BEGIN IMMEDIATE')
        version = connection.execute('PRAGMA user_version').fetchone()[0]
        if version != VERSION:
            connection.execute('DROP TABLE IF EXISTS files')
            connection.execute(f'PRAGMA user_version={VERSION}')
        connection.execute('CREATE TABLE IF NOT EXISTS files (graph TEXT, path TEXT, mtime INTEGER, size INTEGER, tasks TEXT, PRIMARY KEY(graph,path))')
        return connection
    except Exception:
        connection.close()
        raise


def cached_records(payload, graph, relative):
    try:
        records = json.loads(payload)
        if not isinstance(records, list):
            return None
        for record in records:
            if not isinstance(record, dict):
                return None
            for key in ('id', 'content', 'graph', 'source_file', 'source_page'):
                if not isinstance(record.get(key), str):
                    return None
            if record['graph'] != graph or record['source_file'] != relative:
                return None
            if record.get('status') not in STATUSES or record.get('priority', '') not in (*PRIORITIES, None):
                return None
            for key in ('scheduled', 'deadline', 'journal_date'):
                if key not in record or (record[key] is not None and
                        (not isinstance(record[key], str) or not date_value(record[key]))):
                    return None
            location = record.get('block_location')
            if not isinstance(location, dict) or type(location.get('line')) is not int or location['line'] < 1:
                return None
            if record.get('block_reference_status') not in ('missing', 'invalid', 'valid'):
                return None
            if 'block_uuid' not in record:
                return None
            if record['block_uuid'] is not None:
                if not isinstance(record['block_uuid'], str):
                    return None
                uuid.UUID(record['block_uuid'])
        return records
    except (ValueError, TypeError):
        return None


def classify(tasks, today, horizon):
    result = dict(today=[], overdue=[], upcoming=[])
    seen = set()
    for task in tasks:
        if task['id'] in seen:
            continue
        seen.add(task['id'])
        scheduled = date_value(task['scheduled']) if task['scheduled'] else None
        category = None
        if scheduled:
            delta = (scheduled - today).days
            category = 'today' if delta == 0 else 'overdue' if delta < 0 else 'upcoming' if delta <= horizon else None
        elif not task['deadline'] and task['journal_date'] == today.isoformat():
            category = 'today'
        if category:
            result[category].append(task)
    for category, items in result.items():
        items.sort(key=lambda t: (t['status'] != 'DOING', {'A': 0, 'B': 1, 'C': 2, None: 3}[t['priority']],
                                 t['scheduled'] or '' if category != 'today' else '',
                                 t['graph'], t['source_file'], t['block_location']['line'], t['id']))
    return result


def _scan(graphs, cache, *, full_rescan=False, horizon=7, today=None):
    started = time.perf_counter()
    if horizon < 0:
        raise ValueError('horizon must be nonnegative')
    resolved = [(Path(path).expanduser().resolve(), name) for path, name in graphs]
    if not resolved or len({str(p) for p, _ in resolved}) != len(resolved):
        raise ValueError('configure at least one distinct graph directory')
    for path, _ in resolved:
        if not path.is_dir() or not any((path / part).is_dir() and not (path / part).is_symlink() for part in GRAPH_ROOTS):
            raise ValueError(f'invalid graph directory (requires non-symlink pages/ or journals/): {path}')
    cache = Path(cache).expanduser().resolve()
    if any(cache.is_relative_to(path) for path, _ in resolved):
        raise ValueError('cache must be outside graph directories')
    cache.parent.mkdir(parents=True, exist_ok=True)
    connection = connect(cache)
    stats = dict(discovered=0, parsed=0, reused=0, removed=0, extracted_tasks=0)
    tasks = []
    navigation = []
    try:
        for graph, name in resolved:
            graph_id = str(graph)
            current = discover(graph)
            cached = {row[0]: row[1:] for row in connection.execute('SELECT path,mtime,size,tasks FROM files WHERE graph=?', (graph_id,))}
            stats['discovered'] += len(current)
            for relative, metadata in sorted(current.items()):
                old = cached.get(relative)
                records = cached_records(old[2], graph_id, relative) if not full_rescan and old and metadata == old[:2] else None
                if records is not None:
                    stats['reused'] += 1
                else:
                    # Refuse symlinks at open as well as discovery; never follow a replaced leaf.
                    descriptor = open_source(graph, relative)
                    with os.fdopen(descriptor, 'r', encoding='utf-8') as source:
                        before = os.fstat(source.fileno())
                        try:
                            text = source.read()
                        except UnicodeDecodeError as error:
                            raise ValueError(f'{graph}/{relative}: invalid UTF-8: {error}') from error
                        records = parse(text, graph_id, relative)
                        after = os.fstat(source.fileno())
                    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                        raise OSError(f'file changed during scan: {relative}; retry')
                    connection.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?)',
                                       (graph_id, relative, before.st_mtime_ns, before.st_size, json.dumps(records)))
                    stats['parsed'] += 1
                records = [dict(record) for record in records]
                block_states = [r.pop('block_reference_status', 'missing') for r in records]
                for record in records:
                    record['graph'] = name or graph.name
                    target = record['block_uuid'] or record['source_page']
                    record['deep_link'] = 'logseq://graph/' + quote(graph.name, safe='') + '?' + urlencode({'block-id' if record['block_uuid'] else 'page': target})
                navigation.extend(dict(graph_path=graph_id, graph_identifier=graph.name,
                                       source_file=relative, page=r['source_page'],
                                       block_uuid=r['block_uuid'], block_reference_status=state,
                                       target='block' if r['block_uuid'] else 'page',
                                       deep_link=r['deep_link']) for r, state in zip(records, block_states))
                tasks.extend(records)
            for relative in cached.keys() - current.keys():
                connection.execute('DELETE FROM files WHERE graph=? AND path=?', (graph_id, relative))
                stats['removed'] += 1
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    stats['navigation'] = navigation
    stats['extracted_tasks'] = len(tasks)
    stats['cache_hit_ratio'] = stats['reused'] / stats['discovered'] if stats['discovered'] else 0
    stats['duration_seconds'] = time.perf_counter() - started
    return classify(tasks, today or dt.datetime.now().astimezone().date(), horizon), stats


def scan(graphs, cache, **options):
    cache = Path(cache).expanduser().resolve()
    for graph, _ in graphs:
        if cache.is_relative_to(Path(graph).expanduser().resolve()):
            raise ValueError('cache must be outside graph directories')
    cache.parent.mkdir(parents=True, exist_ok=True)
    # The external lock also serializes replacement of a damaged database.
    with open(str(cache) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            return _scan(graphs, cache, **options)
        except sqlite3.DatabaseError as error:
            if getattr(error, 'sqlite_errorcode', None) not in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB) and str(error) != 'cache integrity check failed':
                raise
            cache.unlink(missing_ok=True)
            return _scan(graphs, cache, **options)


def open_source(graph, relative):
    directory = os.open(graph, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = Path(relative).parts
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    finally:
        os.close(directory)
