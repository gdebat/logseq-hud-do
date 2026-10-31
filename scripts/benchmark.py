"""Generated graphs only; run from repository root with PYTHONPATH=."""
import datetime as dt
import json
from pathlib import Path
import tempfile
from logseq_hud_do.backend import scan

for count in (500, 1000, 5000):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        graph = root / 'graph'
        pages = graph / 'pages'
        pages.mkdir(parents=True)
        today = dt.date.today().isoformat()
        for index in range(count):
            (pages / f'{index}.md').write_text(f'- TODO [#B] Task {index}\n  SCHEDULED: <{today}>\n')
        for stage, expected in [('cold', count), ('warm', 0), ('modified', 1), ('deleted', 0), ('created', 1)]:
            if stage == 'modified':
                (pages / '0.md').write_text(f'- DOING changed\n  SCHEDULED: <{today}>\n')
            elif stage == 'deleted':
                (pages / '1.md').unlink()
            elif stage == 'created':
                (pages / 'new.md').write_text('- TODO new')
            _, stats = scan([(graph, None)], root / 'cache.sqlite')
            assert stats['parsed'] == expected, stats
            if stage == 'deleted':
                assert stats['removed'] == 1, stats
            print(json.dumps(dict(files=count, stage=stage, **stats)))
