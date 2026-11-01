# Task display acceptance

Context is the final `St.Label` inside each task button's vertical box. Its
`hud-context` CSS class sets size and padding; Clutter actor opacity 170/255
provides about 67% prominence while inheriting the Shell theme foreground.
The previous CSS `opacity` declaration is unsupported by St and had no effect.
The primary label and badges retain full opacity.

The reactive scrolling wrapper disables PopupBaseMenuItem hover activation,
click activation and actor hover tracking. Headings and section boxes are plain
St actors. Individual task buttons retain their scoped hover/focus CSS.
See [Shell's PopupBaseMenuItem implementation](https://github.com/GNOME/gnome-shell/blob/gnome-46/js/ui/popupMenu.js).

Preferences provides editable/removable line filters in `task-text-filters`.
A matching line is removed in presentation only, before existing priority marker
removal. The default `^[ \t]*relay-id::` removes indented relay properties.
An empty list disables line filtering. Patterns must start with `^`, contain at
most 256 characters and at most one `*` or `+`. Character classes, literals,
escaped punctuation and `\d`, `\s`, `\w` (and inverse forms) are supported.
Groups, alternatives, counted/optional repetitions and backreferences are
rejected to bound backtracking. Invalid patterns remain editable, show an error,
and are ignored. Each pattern matches each description line independently;
matching removes the whole line, not just the matching substring.

## Manual checks (not run here)

On GNOME 46–50 with light and dark Shell themes:

1. Verify graph and scheduled date (`D MMM YYYY`, for example `4 Nov 2026`)
   are muted and readable in Today, Overdue and Upcoming. Unscheduled tasks
   show only the graph, including today’s journal tasks. Page names and deadlines
   are never shown in this line. Task text remains full contrast.
2. Hover headings, empty sections, list padding and scrollbar: no list-wide
   highlight. Hover/focus a task: only that row highlights. Scroll and click tasks;
   verify the same Logseq destinations and successful menu dismissal.
3. Verify High/Medium/Low priority badges followed by a green `Doing` badge for `DOING` tasks and hidden priority markers.
4. Using existing tasks, verify relay property lines disappear but surrounding
   multiline text remains. Add, edit and remove filters, try malformed syntax,
   clear the list, and reopen Preferences to verify persistence.
5. Compare backend JSON/cache with display filtering enabled and disabled: IDs,
   descriptions, grouping, sorting and links must remain unchanged. Do not edit
   graph files for acceptance.

Automated widget doubles cannot establish live Shell rendering, contrast or
pointer delivery. These visual and interaction checks remain manual acceptance.
