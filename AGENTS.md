# Logseq HUD->Do — AI Agent development guide

## Project and scope

- Use AI Agent directly for implementation, testing and review, with standard Git.
- This is a local, offline, read-only task viewer for Logseq OG Markdown graphs.
- Support Python 3.10+ on Linux, using the standard library, and GNOME Shell 46–50.
- Keep the Python backend independent of GNOME; the extension bundles that backend.
- Preserve the minimal-dependency design and absence of a permanent background service.
- Task editing/completion, Logseq DB graphs, cloud sync, recurring-task expansion,
  web interfaces and AI features are outside the established scope unless requested.

## Repository map and documentation

- `logseq_hud_do/backend.py`: parsing, safe source access, discovery, SQLite index,
  classification, sorting, navigation targets and block-context queries.
- `logseq_hud_do/journal_config.py`: limited, non-evaluating configuration reader
  and supported journal filename/title formats.
- `logseq_hud_do/__main__.py`: argument parsing and JSON CLI/error channels.
- `logseq_hud_do/graph-roots.json`: shared graph-root inventory (`pages`, `journals`);
  backend and preferences consume it, and both installers bundle it.
- `extension/model.js`: command arguments, response validation, presentation filters,
  hidden-task identity/registry and asynchronous refresh coordination.
- `extension/extension.js`: Shell actors, refresh/subprocess lifecycle, navigation,
  confirmation dialogs and block-context preview interactions.
- `extension/prefs.js`, `extension/schemas/`: GTK 4/libadwaita preferences and GSettings.
- `extension/metadata.json`, `extension/stylesheet.css`: compatibility and Shell styling.
- `tests/`: Python unittest suites, GJS model/positioning checks, Node widget/lifecycle
  doubles, producer/consumer contract checks and disposable installation tests.
- `scripts/`: user installers and generated-graph benchmark; `Makefile` owns checks.
- Read `README.md` for architecture, operation, installation and limitations.
- Read `docs/requirements.md` for requirements and scope, and
  `docs/json-interface-v1.md` before changing either side of the CLI boundary.
- Use `docs/navigation-acceptance.md`, `docs/ui-acceptance.md` and
  `docs/gnome-compatibility.md` for their respective manual acceptance procedures.
- `.github/workflows/ci.yml` declares CI; `.github/ISSUE_TEMPLATE/` holds issue templates.
- Verify documentation against current code and tests. Investigate contradictions;
  do not silently promote historical statements into current implementation facts.
- Historical phase sequencing is context, not a requirement to rerun completed phases.

## Understand, implement and review

1. Read the associated GitHub issue and its acceptance criteria when provided.
   Check the configured forge remote before using GitHub tools.
2. Inspect the affected implementation, tests, relevant docs and both sides of any
   interface. Identify dependencies, invariants and the smallest safe change.
3. Clarify genuinely ambiguous requirements; resolve routine choices from evidence.
   Understand the affected paths before substantial implementation.
4. Implement focused changes using existing helpers. Avoid unrelated refactoring,
   duplicated functionality, unnecessary services or new dependencies.
5. Add suitable tests for new behavior. For bugs, demonstrate the regression fails
   before the fix and passes afterward where practical.
6. Run the applicable checks below. Inspect the final diff against the issue and
   check regressions, security, compatibility, lifecycle cleanup and missing tests.
7. For substantial work, use an independent review in a fresh AI AGent session where
   practical. A review-only task must not modify repository files or external state.
   Report proved findings with source locations, reachable consequences and the
   smallest correction; keep unproved concerns explicitly inconclusive.

## Git and GitHub

- Inspect `git status`, the current branch, relevant diffs and remotes first.
- Use feature branches for development. Prefer the latest `main` after checking
  the intended remote and available updates; never discard local divergence.
- Follow existing descriptive `feature/`, `feat/` or `fix/` branch conventions.
  Historical `archon/` and `build/` names are not templates for new work.
- Keep changes scoped to the task. Inspect dirty state and preserve unrelated edits;
  use a standard Git worktree when isolation is useful and authorized.
- Never reset or clean the worktree without explicit authorization. Preserve history;
  do not recreate the repository or change remotes as routine setup.
- Do not assume `origin` is GitHub or the intended upstream; inspect configuration.
- Do not commit, push, create PRs, merge or close issues unless explicitly requested.
  When requested, use concise descriptive commits consistent with nearby history.
- Update relevant docs for changed behavior/contracts when within scope. Keep PR
  descriptions focused on the final behavior and validation, without private data.

## Implementation conventions and interfaces

- Match nearby code: four-space indentation, Python snake_case, JavaScript
  camelCase, ES module imports and single-quoted strings where practical.
- Keep extraction/classification/cache logic in Python and display formatting in
  `taskPresentation()`/`displayContent()`. Do not change persisted data to style it.
- The extension uses asynchronous `Gio.SubprocessLauncher.spawnv` with argument
  arrays and the bundled backend directory. Never interpolate task data into a shell.
- Successful task-list stdout is one JSON object with `today`, `overdue`, `upcoming`.
  Preserve the fields, nullability and vocabulary in `docs/json-interface-v1.md`.
- JSON interface v1 is a documented contract revision, not a response version field;
  incompatible changes require a coordinated producer/consumer revision.
- Keep diagnostics on stderr. Backend operational failures return JSON `error` on
  stderr and nonzero status; argparse usage errors remain plain text.
- Preserve visible failure handling: failed refreshes clear stale tasks/counts and
  surface an error. Do not silently turn source/configuration failures into success.
- `--block-context` is a separate one-shot, single-graph query that bypasses SQLite.
  Preserve its parent/current/direct-children contract and separate context grammar;
  changing context parsing must not silently change task extraction or identity.
- Coordinate vocabulary and boundary changes across backend, model, preferences,
  schema, metadata, installers, contract tests and documentation as applicable.

## Task and persistence invariants

- Extract only TODO and DOING; associate metadata with its owning block, including
  non-task children. Preserve nested-block/tab handling and fenced-code suppression.
- Classify by local date on every scan, including warm scans. Today includes scheduled
  tasks for today and today's journal tasks lacking both schedule and deadline.
  Overdue has scheduled dates before today; Upcoming is within the inclusive horizon.
  Deadlines do not drive classification; do not expand recurring schedules.
- Backend sorts each category: DOING before TODO, A/B/C/no priority, then scheduled
  date ascending for Overdue/Upcoming, then graph display name, source path, line, ID.
  Today omits the date sort key. The extension preserves this order except for the
  optional, default-enabled stable A-first partition of scheduled Today; disabling
  `today-priority-a-first` restores backend order without rescanning.
- UI sections are Today, Today — Unscheduled, Overdue, Upcoming; omit empty/disabled
  sections and put separators only between populated sections. After hidden filtering,
  use the same preference-dependent Today arrays for rows and the panel count.
- DOING alone gets a status badge. Priorities display High/Medium/Low; no priority
  gets no placeholder. Keep raw values intact while removing display markers.
- Description filters are presentation-only. Preserve restricted anchored regex
  validation and literal block-filter behavior; do not broaden regex syntax casually.
- Distinguish backend IDs from hidden-task logical identity. Backend fallback IDs
  hash graph/path/original first-line text/status/occurrence, not line number alone.
  Stored UUID IDs are graph-qualified; duplicate UUIDs retain the first occurrence.
- Hidden identity uses canonical graph path, resolved source page, normalized content
  and scheduled date. It ignores display aliases, status, first-line priority markers
  and display filters. Do not substitute backend IDs for this identity.
- Preserve the versioned hidden registry, unknown-data protections and confirmed reset
  behavior. Failed settings writes must remain visible and permit retry, without
  falsely reporting success or closing a confirmation that needs correction.
- Reuse GSettings bindings and derive numeric bounds from the schema. Preserve key
  types/defaults and existing persisted formats unless an explicit migration is in scope.
- Read journal settings on every scan, independently of cached extraction. Preserve
  supported format inventories, explicit `title::` precedence and namespace decoding.
  Only missing configuration/settings use defaults; detected syntax errors, unsupported
  formats, unreadable/unsafe config and invalid UTF-8 must reach the error channel.
- Navigation uses the canonical directory basename, not its display alias. Only a
  valid stored `id::` UUID produces a block link; otherwise use the resolved page.
  Never synthesize a block UUID from a hash or write UUIDs into Markdown.
- Keep missing protocol-handler errors distinct from asynchronous activation failures.
  Successful Gio activation does not prove Logseq reached the intended page/block.

## Filesystem safety and privacy

- Treat real personal graphs as read-only unless the user explicitly authorizes writes.
  Never modify, delete, rename, reformat or migrate them during testing.
- Use disposable generated graphs and sanitized fixtures for tests/manual acceptance.
  Read private graph content only when necessary and authorized; never put it in
  committed fixtures, logs or documentation, or upload/transmit it to external services.
- Treat Markdown/configuration as untrusted data: never execute it or enable markup
  interpretation for note text. Keep the application offline and free of telemetry.
- Preserve canonical graph-root boundaries and scan only Markdown under the shared
  roots. Skip symlink files/subdirectories and require a non-symlink scan root.
- Preserve descriptor-relative `open_source()` traversal with `O_NOFOLLOW`, regular-file
  checks and nonblocking opens. Reject context path traversal/absolute paths at the
  public boundary; do not replace guarded source opens with ordinary path reads.
- Keep SQLite and its lock outside every configured graph. Never weaken filesystem
  protections to simplify tests or run destructive commands against graph directories.
- Do not dump environment values, credentials, auth files or keyrings for diagnostics.
  Prefer explicit tool metadata and sanitized, narrowly scoped output.

## Performance and asynchronous work

- Preserve incremental SQLite indexing by canonical graph and relative file, using
  `mtime_ns`/size for reuse. Routine warm refreshes must avoid reparsing unchanged
  Markdown and unnecessary data writes; retain explicit `--full-rescan` recovery.
- Preserve transaction rollback, advisory locking, corrupt-cache recovery and cached
  record validation. Extraction/schema changes must consider cache version invalidation.
- Reclassify cached tasks for date/horizon changes without forcing Markdown reparsing.
  Support multiple graphs without leaking records from omitted graphs into output.
- Keep scanning off the Shell main thread. Refresh requests coalesce; do not overlap
  task-list scans or starve publication with repeated periodic/open requests.
- Preserve refresh on open/manual/interval/settings/local midnight. Hidden-registry
  and unscheduled-visibility changes currently rerender without a backend subprocess;
  retain that behavior and avoid adding expensive work to presentation-only changes.
- Keep previews on demand and debounced; reuse the current interaction's response.
  Cancel obsolete requests and reject late callbacks after row changes or destruction.
- On disable/dismissal, remove owned GLib sources, disconnect external signals,
  cancel communication, terminate owned children and release actors/dialogs/modal grabs.
- Use `make benchmark` for scan/cache/performance changes. It generates 500/1,000/5,000
  files and asserts parsed counts for cold/warm/modified/deleted/created stages.
  Compare timings and parsed counts; do not invent absolute latency thresholds.

## Validation and GNOME compatibility

- Repository checks (also run by CI):
  - `make test`: all Python unittest suites, including contract and installation tests.
  - `make check`: Python compilation and standalone installer shell syntax.
  - `make test-extension`: GJS model/positioning, Node regression/UI/preferences and
    Python extension contract/installation tests.
  - `make check-extension`: strict schema dry run, JavaScript syntax and installer syntax.
- Backend-only iteration: `python3 -m unittest discover -s tests -p 'test_backend.py' -v`.
  Run focused tests while iterating and applicable full gates before completion;
  production changes spanning both components normally require all four targets.
- Full checks need Python, Node.js, GJS, GLib schema/settings tools and GNOME dependencies;
  see README and CI for setup. Node is a development dependency, not a runtime service.
- Use unittest/tempfile fixtures and existing Node/GJS harnesses. Test actual behavior,
  error channels and both sides of interfaces; aggregate coverage alone is insufficient.
- For cache/parser changes, cover cold/warm/full-rescan behavior and invalidation where
  relevant. For preferences, cover enabled/disabled/toggled states and adjacent behavior.
- Shell metadata declares 46–50. Preserve existing API feature detection (including
  BoxLayout orientation/vertical), GTK 4/libadwaita preferences and supported GJS imports.
- Check real GI/Shell API signatures when changing runtime calls. Node actor doubles,
  syntax checks and even GJS tests do not prove live Shell APIs/layout work.
- Keep ordinary text theme-inherited, note text literal, badges readable, and rows
  keyboard accessible. Preserve focus, Escape, scrolling and confirmation defaults.
- Preview layout must respect the owning monitor's work area, scaling and fallback;
  scrolling/scrollbar dragging must not accidentally activate navigation.
- Runtime interactions require live GNOME acceptance on affected supported majors:
  themes, scaling/multiple monitors, keyboard/pointer behavior, URI navigation, refresh
  and disable during pending work, using the referenced acceptance checklists.
- README and compatibility notes disagree about past live testing. Claim runtime
  validation only from recorded version-specific evidence; report unavailable gates.
- Documentation-only changes need path/command/diff checks, not an automatic full
  runtime suite. Never report declared, skipped or mocked checks as executed live tests.

## Completion and prohibited actions

- Report changes and files modified, tests executed and pass/fail/skips, remaining
  risks/limitations, required manual acceptance, and final Git branch/status.
- Do not automatically commit or push. Do not install/deploy into the user's active
  desktop merely to validate; installer tests use temporary XDG destinations.
- Do not invoke Archon CLI commands, start Archon workflows, create Archon worktrees
  or depend on Archon-specific state/artifacts for development, testing or review.
- Existing Archon-generated documentation may be consulted as historical knowledge.
  Do not modify or delete it unless explicitly requested. Future work must remain
  usable through standard Git, AI Agent and the repository's own validation commands.
