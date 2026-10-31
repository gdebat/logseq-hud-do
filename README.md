# Logseq HUD Do

Phase 1: an offline, read-only Python backend for Logseq OG Markdown graphs.
Python 3.10+ on Linux is required; there are no third-party dependencies.
The GNOME extension and its settings and refresh lifecycle are Phase 2 and are
not implemented.

Run from this directory:

```sh
python3 -m logseq_hud_do --graph /path/to/graph --graph-name Personal --diagnostics
```

Repeat `--graph` for multiple graphs. Optional `--graph-name` values correspond
in argument order. `--horizon 7` includes the seventh upcoming day.
`--full-rescan` reparses every discovered file. `--cache PATH` overrides
`${XDG_CACHE_HOME:-~/.cache}/logseq-hud-do/tasks.sqlite3` and must be outside
all configured graphs. Graphs must contain `pages/` or `journals/`.

For user installation, run `sh scripts/install.sh` and put `~/.local/bin` on
PATH. Then use `logseq-hud-do` with the same arguments. No sudo is required.
To uninstall, remove `~/.local/bin/logseq-hud-do` and
`${XDG_DATA_HOME:-~/.local/share}/logseq-hud-do`.

Successful stdout is a JSON object containing `today`, `overdue`, and `upcoming`
arrays. Dates are ISO dates or null. Priority is A/B/C or null. Each record
includes content, status, graph display name, graph-relative source file,
source page, journal date, block location (one-based line), identifier, block
UUID if present, and a Logseq deep link. Diagnostics go to stderr; failures
produce a JSON error on stderr and a nonzero exit code. Argument syntax errors
use argparse's standard stderr usage message.

Both TODO and DOING are returned. DOING precedes TODO, then A/B/C/no priority;
dates order Overdue and Upcoming within those groups. Today uses deterministic
source order. Unscheduled tasks appear only in today's journal and only without
a deadline. Classification uses the local date on every invocation, including
warm-cache executions. Consumers should refresh on local midnight.

## Architecture and cache

`logseq_hud_do/backend.py` scans only Markdown under pages and journals,
parses blocks line by line, and stores raw extraction records in SQLite keyed
by canonical graph directory and relative path. Metadata belongs to its nearest
block, including non-task children. Fenced code is ignored. Scheduling dates
and deadlines on owned metadata lines are retained without expanding recurrence.
Both fields may share one metadata line, in either order. Malformed task-owned
scheduling values fail the refresh; date mentions within ordinary prose remain content.
Owned non-metadata continuation lines are preserved in task content.

Nanosecond mtime and size determine reuse. One transaction covers each refresh;
a Linux advisory lock serializes processes and corrupted-database recovery.
Interrupted transactions roll back. Parser/schema version changes invalidate
the index. Warm scans perform no data writes. Removed files are removed from
the index; graphs omitted from an invocation are not returned. Corrupt caches
are disposable and rebuilt. Graph files are never written. Symlink files and
subdirectories are skipped, and source opens reject symlink components.

## Development and benchmarks

```sh
make test
make check
make benchmark
```

Tests use temporary generated graphs only. Benchmarks generate 500, 1,000 and
5,000 files and report JSON timings and parsed counts for cold, warm, modified,
deleted, and created-file refreshes. Expected parsed counts are asserted.
`make check` compiles Python and checks installer shell syntax; no external
linter or type checker is configured.

## Limitations and troubleshooting

Only OG Markdown is supported. Journal names supported are YYYY_MM_DD,
YYYY-MM-DD, and English abbreviated/full month names such as Oct 31, 2026
(month-name parsing follows the process locale). Arbitrary custom journal
formats and Logseq DB graphs are unsupported. Dates without valid ISO calendar
values and invalid UTF-8 fail the refresh with source context. Deadline dates do not classify
tasks. Markdown is never executed or rendered.

Without a UUID, identifiers hash graph, file, original task text, status and
same-text occurrence. They survive unrelated inserted lines, but changing task
text/status, moving files, or reordering identical tasks can change identity.
Duplicate block UUIDs within a graph return the first source occurrence.
Deep links depend on Logseq's registered desktop protocol and graph basename;
the backend does not launch Logseq or verify protocol registration.

If metadata was preserved by another tool, use `--full-rescan`. If a graph or
cache is unreadable, fix its permissions or use another cache location. A file
changed or deleted during reading can fail the invocation; retry the refresh.
SQLite failures report an error; damaged databases rebuild automatically.
A graph actively being rewritten is not a graph-wide filesystem snapshot.
