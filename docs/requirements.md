# Logseq HUD Do — Implementation Requirements

## 1. Objective

Develop a lightweight, native GNOME Shell extension for Ubuntu named **Logseq HUD Do**.

The extension displays active tasks from local **Logseq OG Markdown-only graphs** without requiring Logseq to be running.

The project repository is `logseq-hud-do`. An existing private Git remote has already been configured.

Do not recreate the repository or modify its remote configuration.

### Core principles

- Logseq remains the single source of truth.
- Fully local and offline.
- Read-only access to Logseq graphs.
- Efficient operation with 500+ Markdown pages.
- Minimal dependencies.
- Native GNOME appearance and behavior.
- Maintainable, testable architecture.
- No permanent background service.

## 2. Architecture

Separate the application into two components.

### Python backend

Responsible for:

- Discovering Logseq Markdown files.
- Incrementally parsing changed files.
- Maintaining a persistent task cache.
- Extracting task metadata.
- Classifying tasks into categories.
- Sorting tasks.
- Producing structured JSON output.

The backend must operate independently of GNOME.

### GNOME Shell extension

Written in modern JavaScript using GJS.

Responsible for:

- Displaying the top-panel indicator.
- Rendering task categories.
- Rendering task status and priority badges.
- Running the backend asynchronously.
- Displaying preferences.
- Supporting manual and automatic refresh.
- Opening tasks in Logseq where supported.

The extension must not block GNOME Shell's main thread.

## 3. Logseq Format

Support Logseq OG Markdown graphs only.

Scan:

- `pages/`
- `journals/`

Support multiple configurable graph directories.

### Task markers

Include:

- `TODO`
- `DOING`

Exclude all other task markers. `TODO` will not be shown, as per 8.3 

### Priority markers

Recognize:

- `[#A]`
- `[#B]`
- `[#C]`
- No priority

Preserve the original priority value internally.

### Scheduled dates

Recognize Logseq Markdown scheduling syntax, such as:

`SCHEDULED: <2026-10-31 Sat>`

Scheduling metadata must be associated with the correct block.

Support nested Markdown blocks without incorrectly assigning child metadata to parent tasks.

Preserve `DEADLINE` metadata where available, but use `SCHEDULED` for date-based classification in the MVP.

Do not expand recurring schedules into additional occurrences.

Use the currently stored scheduled date.

## 4. Task Classification

The backend produces three categories in this order. The extension splits Today
into scheduled and unscheduled presentation sections (see 8.2).

### 4.1 Today

Include:

1. Active tasks scheduled for the current date, regardless of their source page.
2. Active tasks from today's journal without either a scheduled date or deadline.

Exclude tasks from today's journal that are explicitly scheduled for another date.

### 4.2 Overdue

Include active tasks with scheduled dates before today.

### 4.3 Upcoming

Include active tasks with scheduled dates after today.

Default to a configurable seven-day upcoming horizon, inclusive of the seventh day.

### 4.4 General rules

- Every task appears in at most one category.
- Unscheduled tasks from older journals and ordinary pages are excluded.
- Only active TODO and DOING tasks are included.
- Date comparisons use the system's local timezone.
- Classification must be recalculated when the local date changes, even if no Markdown files have changed.

## 5. Sorting

Sort each category independently.

### Primary: Task status

1. DOING
2. TODO

### Secondary: Priority

1. A — High
2. B — Medium
3. C — Low
4. No priority

Task status always takes precedence over priority.

### Tertiary

- Today: Deterministic source order.
- Overdue: Scheduled date ascending.
- Upcoming: Scheduled date ascending.

Use stable identifiers or source locations as final tie-breakers.

All sorting must be performed by the backend.

## 6. Phase 1 — High-Performance Backend

**Performance is a primary requirement.**

The application must efficiently support Logseq graphs containing hundreds or thousands of Markdown files.

Repeatedly parsing every Markdown file during each refresh is unacceptable.

### 6.1 Incremental parsing

Implement a persistent per-file task index.

On first execution:

1. Discover all Markdown files in configured graph directories.
2. Parse each file.
3. Extract active tasks and metadata.
4. Save the results to a persistent cache.

On subsequent executions:

1. Discover current Markdown files.
2. Compare file metadata against cached metadata.
3. Reuse cached task data for unchanged files.
4. Parse only new or modified files.
5. Remove entries for deleted files.
6. Reclassify and sort cached tasks.

Use high-resolution modification timestamps (`mtime_ns`) and file sizes as the normal change-detection mechanism.

Provide an explicit full-rescan command for situations where metadata-based detection cannot be trusted.

### 6.2 Persistent caching

Prefer Python's built-in SQLite library.

Cache at least:

- Graph identifier
- Relative file path
- File modification timestamp
- File size
- Extracted task records
- Parser/cache schema version

Automatically invalidate incompatible cached data after parser or schema changes.

Store cache data in an appropriate user cache directory following XDG conventions.

Do not store cache files inside Logseq graphs.

### 6.3 Efficient Markdown parsing

Avoid heavyweight Markdown rendering or full document-tree construction unless justified by measured performance or correctness requirements.

Prefer a streaming or line-oriented parser capable of recognizing:

- Logseq task markers
- Priority markers
- Scheduled dates
- Deadline dates
- Nested block boundaries
- Block UUIDs
- Journal filenames

The parser must correctly distinguish task content from metadata belonging to nested child blocks.

Do not execute or render Markdown content.

### 6.4 Refresh behavior

The extension must refresh:

- When its dropdown opens.
- At a configurable interval, defaulting to 30 seconds.
- After settings change.
- When the local date changes.

Do not spawn overlapping backend processes.

Do not introduce a permanent filesystem-monitoring daemon.

Ensure subprocesses are cleaned up when the extension is disabled.

### 6.5 Concurrency and cache integrity

Use safe SQLite transactions.

Handle concurrent or interrupted backend executions without corrupting the task cache.

Avoid performing unnecessary writes when no source files have changed.

Use atomic operations where applicable.

### 6.6 Performance diagnostics

Provide optional diagnostics containing:

- Number of discovered files.
- Number of parsed files.
- Number of reused cached files.
- Number of removed files.
- Number of extracted tasks.
- Total execution duration.
- Cache hit statistics.

Send diagnostic output to stderr or a separate diagnostic mode.

Keep standard JSON output free from diagnostic messages.

### 6.7 Performance benchmarks

Include a reproducible benchmark using generated fixture graphs.

Test at least:

- 500 Markdown files.
- 1,000 Markdown files.
- 5,000 Markdown files.

Measure:

1. Initial cold scan.
2. Warm execution with no changes.
3. Refresh after modifying one file.
4. Refresh after deleting one file.
5. Refresh after creating one file.

The benchmark must report execution times and number of files actually parsed.

Optimization priority:

1. Correctness.
2. Avoid unnecessary file parsing.
3. Minimize refresh latency.
4. Minimize memory usage.
5. Minimize CPU and disk activity.

Do not sacrifice task correctness for performance.

## 7. Backend Output

Provide a JSON CLI interface.

Each task record must include:

- Stable identifier
- Content
- Status
- Priority
- Scheduled date
- Deadline date
- Graph display name
- Source file
- Source page or journal
- Block location
- Logseq deep link, where available

Use Logseq block UUIDs when present.

Do not use line numbers alone as stable identifiers.

Do not modify source Markdown files to generate UUIDs.

Return separate arrays for:

- `today`
- `overdue`
- `upcoming`

Provide clear error reporting without corrupting JSON output.

## 8. Phase 2 — GNOME Shell Extension

### 8.1 Panel indicator

Display a checklist-style symbolic icon in the GNOME top panel.

Optionally display the number of Today tasks beside the icon.

Clicking the indicator opens a dropdown.

### 8.2 Dropdown layout

Display nonempty sections in this order:

1. Today: tasks in the backend Today category with a scheduled date.
2. Today — Unscheduled: tasks in the backend Today category without a scheduled date.
3. Overdue
4. Upcoming

Each section displays its task count. “Show today's unscheduled tasks” defaults to
enabled and controls the second section and its contribution to the panel Today
count. Changes apply immediately and
persist through GSettings, without changing task identities or hidden-task records.

The dropdown must support:

- Scrolling.
- Long task descriptions.
- Empty states.
- GNOME light and dark themes.
- Appropriate scaling.
- Automatic refresh.

### 8.3 Task status indicators

Only display a status indicator for `DOING` tasks.

**DOING tasks:**
- Display a prominent green `Doing` badge.
- Include an appropriate progress-style icon or symbol.
- Use a GNOME-compatible accent color.
- Ensure the indicator is visually distinguishable and accessible.
- The indicator should make it immediately obvious why these tasks appear before other tasks, regardless of priority.

**TODO tasks:**
- Do not display any task status indicator, icon, or badge.
- Display only the task description and applicable priority badge.
- Preserve consistent alignment and spacing across task rows.

The backend must continue to recognize and sort both `TODO` and `DOING` tasks.

### 8.4 Human-readable priority badges

Translate Logseq priority markers into human-readable labels.

| Logseq priority | Display label | Color |
|---|---|---|
| `[#A]` | High | Red |
| `[#B]` | Medium | Amber/Yellow |
| `[#C]` | Low | Blue |
| None | No badge displayed | — |

Requirements:
- Display compact, colored badges for High, Medium, and Low priorities.
- Use accessible colors with sufficient contrast in GNOME light and dark themes.
- Do not display raw Logseq priority markers.
- **If a task has no priority, do not display any priority indicator, badge, placeholder, or text such as "No priority".**
- Do not modify the underlying priority values.
- Keep priority presentation independent of backend sorting logic.

### 8.5 Task rows

Each task row should display:

- Task description.
- High, Medium, or Low priority badge, only when a priority is assigned.
- Green `Doing` status badge after the priority badge, only when the internal status is `DOING`.
- Source graph.
- Scheduled date or source context where relevant.

Keep the layout compact, consistent, and suitable for a GNOME Shell dropdown.

Tasks without status or priority badges must not contain unnecessary whitespace or empty placeholders.

### 8.6 Task interaction

Clicking a task should open its original Logseq page or block, where supported.

Do not modify task status or source files.

Handle unavailable Logseq desktop integration gracefully.

## 9. Settings

Provide a preferences interface supporting:

- Multiple graph directories.
- Graph display names.
- Refresh interval.
- Upcoming task horizon.
- Show/hide Overdue.
- Show/hide Upcoming.
- Show/hide Today task count.

Use standard GNOME settings mechanisms.

Do not hardcode graph locations.

Validate configured directories before scanning.

## 10. Security and Privacy

The application must operate entirely offline.

Requirements:

- No telemetry.
- No network transmission of graph contents.
- No modification of Logseq files.
- No execution of Markdown content.
- No shell-command interpolation using task data.
- No scanning outside configured graph directories.
- Safe subprocess invocation.
- Safe handling of malformed Markdown.
- Safe handling of symbolic links and unexpected file paths.

Treat graph contents as untrusted input.

## 11. Error Handling

Handle:

- Missing graph directories.
- Invalid graph configurations.
- Permission errors.
- Malformed Markdown.
- Invalid dates.
- Deleted files.
- Cache corruption.
- Cache schema changes.
- Backend execution failures.
- Unsupported GNOME versions.
- Logseq not running.

Failures must not crash GNOME Shell.

## 12. Testing

### Backend tests

Cover:

- TODO and DOING extraction.
- Exclusion of inactive tasks.
- Priority parsing.
- Scheduled-date parsing.
- Deadline preservation.
- Nested blocks.
- Multiple graph support.
- Journal date formats.
- Today classification.
- Overdue classification.
- Upcoming classification.
- Duplicate prevention.
- Status-first sorting.
- Priority sorting.
- Date sorting.
- Stable task identifiers.
- Midnight and timezone boundaries.
- Malformed files.

### Cache tests

Cover:

- Initial cache creation.
- Warm-cache reuse.
- Modified file invalidation.
- New file discovery.
- Deleted file removal.
- Cache schema migration or invalidation.
- Corrupted cache recovery.
- Concurrent execution.
- Interrupted execution.
- Manual full rescan.
- Date rollover without file modification.

### Extension tests

Verify:

- Panel indicator.
- Dropdown rendering.
- Category ordering.
- Task sorting preservation.
- DOING status indicators.
- TODO status indicators.
- Colored priority badges.
- Light/dark theme compatibility.
- Refresh behavior.
- Error states.
- Extension cleanup.

Use generated fixture graphs for automated tests.

Never modify real Logseq graphs during testing.

## 13. Documentation

Provide:

- Project README.
- Architecture overview.
- Installation instructions.
- Configuration instructions.
- Development instructions.
- Test commands.
- Benchmark instructions.
- Cache behavior documentation.
- Known limitations.
- Troubleshooting instructions.

Provide a user-level installation script.

Avoid requiring sudo.

## 14. Implementation Sequence

### Phase 1 — Backend

Implement:

1. Markdown parser.
2. Incremental file scanner.
3. Persistent SQLite cache.
4. Task classification.
5. Task sorting.
6. JSON CLI.
7. Automated tests.
8. Performance benchmarks.

**Do not start the GNOME interface until the backend passes validation.**

### Phase 2 — GNOME extension

Implement:

1. Panel indicator.
2. Dropdown interface.
3. Today, Overdue and Upcoming sections.
4. DOING/TODO status indicators.
5. Colored High/Medium/Low priority badges.
6. Backend integration.
7. Refresh behavior.
8. Preferences.
9. Logseq deep links.
10. Installation support.

### Phase 3 — Validation and review

Perform:

- Backend correctness tests.
- Cache correctness tests.
- Performance benchmarks.
- Extension compatibility checks.
- Code quality checks.
- Security review.
- Documentation review.

Document any validation steps requiring a live GNOME session.

## 15. Scope Restrictions

Do not implement:

- Task editing.
- Task completion from the extension.
- Cloud synchronization.
- Logseq DB support.
- Standalone web interface.
- Permanent background services.
- AI features.
- Recurring-task expansion.
- Unnecessary dependencies.

## 16. Completion Criteria

The implementation is complete when:

- Task extraction is correct.
- Task classification is correct.
- Sorting follows status, priority and date rules.
- Unchanged files are not reparsed during routine refreshes.
- Persistent caching survives backend process restarts.
- Date rollover works without source-file changes.
- All automated backend tests pass.
- Performance benchmarks demonstrate incremental behavior.
- The GNOME extension displays all three task categories.
- DOING and TODO tasks are visually distinguishable.
- Priority badges display High, Medium and Low with appropriate colors.
- Refresh and preferences work.
- No Logseq source files are modified.
- Installation and troubleshooting are documented.
