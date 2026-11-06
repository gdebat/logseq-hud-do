# JSON interface v1

Version 1 is the current CLI stdout contract, shared by the bundled backend and
extension. The version is the contract revision, not a new response field.
Incompatible vocabulary or field changes require a new contract revision and
coordinated producer/consumer changes. No runtime negotiation is performed.

Successful stdout is one JSON object with category arrays `today`, `overdue`,
`upcoming`, in that display order. Every task has `id`, `content`, `status`,
`priority`, `graph`, `graph_path`, `source_file`, `source_page`, `journal_date`,
`block_location`, `block_uuid`, `scheduled`, `deadline`, and `deep_link`.
Dates are ISO date strings or null; priority is A, B, C or null; status is TODO
or DOING. `block_location` contains the one-based integer `line`.
`block_uuid` and `deep_link` may be null. Other fields are strings.
TODO has no status badge; DOING has a badge. A/B/C mean High/Medium/Low.

Graph roots are the backend's `GRAPH_ROOTS` (currently pages and journals);
preferences must accept each real directory and refuse symlink-only roots.
Errors produce a nonzero exit status and a JSON `error` string on stderr
(except argparse usage errors, which are plain text).

`tests/test_extension_contract.py` derives all status/priority combinations
and graph roots from the backend owner, passes real CLI output through the
extension model, checks vocabulary agreement, and drives preferences validation
with the backend's roots and no-follow semantics.

`source_page` is the resolved Logseq title, including default ordinal journal
names, the supported graph-configured `yyyy-MM-dd, EEE` journal title, explicit
`title::`, and decoded namespace filenames. For journals with a resolved date and
no explicit title, the page title uses
the current graph configuration even when extraction records are cached. Without
a configured filename format, unresolved filenames (including invalid date-shaped
stems) fall back to the decoded filename stem unless an explicit title is present.
With a configured filename format,
a task-bearing journal path that cannot resolve to a valid date fails the scan.
`deep_link` prefers
a stored block UUID; otherwise it targets that title. Display aliases never
select the graph. Optional CLI diagnostics include per-task navigation resolution
without changing task fields. See [manual acceptance](navigation-acceptance.md).

`graph_path` is the canonical absolute graph directory, independent of display aliases.
It is included on both cached and freshly parsed tasks.

## Block-context sub-command

`--block-context SOURCE_FILE BLOCK` is a separate one-shot query, not part of the
task-list contract above. It requires exactly one `--graph` and does not touch the
cache. The extension spawns it the same way as a scan (a fresh subprocess that
prints one JSON object to stdout and exits); there is no persistent process or
runtime negotiation, consistent with the no-background-service requirement.

`SOURCE_FILE` is the task's `source_file` (relative to the graph); `BLOCK` is the
identity the task list already carries — a stored block UUID, the `graph_path:uuid`
form, or the backend task-hash `id`. The source file is opened through the same
`O_NOFOLLOW` path as the scanner and Markdown is never executed.

Successful stdout is one JSON object with `graph`, `graph_path`, `source_file`,
`parent`, `current` and `children`. `parent` is the ancestor chain outermost to
innermost; `children` are the direct child blocks only (one indentation level
deeper), using the same Logseq OG block rules as extraction (indentation nesting,
fenced-code suppression, `key:: value` metadata lines). Each block has `content`
(the block's own possibly multi-line text, markers and scheduling included),
`uuid` (or null) and `block_location.line`. A missing block or unreadable source
produces a nonzero exit and a JSON `error` string on stderr, like the scan command.
