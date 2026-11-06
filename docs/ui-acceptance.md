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

## Block context preview

Preview uses `view-more-symbolic` beside the unchanged Hide icon. Pointer entry
starts a 300ms one-shot debounce. Leaving before the response cancels pending
work; once shown, a 180ms dismissal delay lets the pointer cross the gap to the
scrollable popup. Returning to the button reuses that response. Clicking or
keyboard-activating Preview opens immediately; Escape dismisses it. Moving
keyboard focus outside the interaction also dismisses it once the pointer leaves.
Refreshing the rows, closing the menu, and disabling destroy the interaction.
Clicking anywhere in the popup opens the selected task through the same navigation
helper and URI as its task entry, after dismissing the popup and cleaning up its
timers/request. Enter, keypad Enter and Space activate the focused popup; keyboard
Preview activation gives it focus. The page header underlines on hover/focus.
Wheel scrolling and pointer drags do not activate navigation.
Scrollbar actors and their descendants are excluded from navigation, including
stationary clicks on either the thumb or track.

The floating box uses Shell's `popup-menu` foreground and `popup-menu-content`
surface, with muted parent actors and literal, multiline labels. A wrapping page
header uses the selected task's `source_page` from the latest task refresh, which
already resolves explicit page titles and per-graph journal-title settings. No
extra scan is needed for the header. A theme separator distinguishes it from the
hierarchy. Only the topmost displayed block uses `•`; subsequent ancestors, the
selected task and its direct children use `↳`. Indentation advances per ancestor,
with all direct children aligned one level below the selected task. Width and height
are bounded to the button monitor's work area, falling back to the primary monitor.
Positioning prefers below, then above or beside; overflow scrolls vertically.
The popup temporarily widens the panel menu's modal input grab to `uiGroup` so
its scrollbar is interactive, and releases that grab on dismissal.

On each supported Shell major (46–50), using disposable graphs:

1. Hover briefly, then for 300ms; check only the latter opens a preview. Cross
   between button and popup, scroll many children, re-enter, and switch rows rapidly.
2. Check complete multiline parent/current/child content, long unbroken text,
   both themes, and legibility of muted parents over contrasting backgrounds.
   Check the page header (including long titles and configured journal titles),
   one top-level bullet, arrows and indentation with/without parents or children.
   Include an unbulleted root heading with unindented properties and three nested
   parents; all ancestors must remain visible above the selected task.
3. Check all screen edges, secondary monitors, work-area reservations and scaling.
   Verify the popup stays visible and the scrollbar remains usable.
4. Tab to Preview, activate with Space/Enter, dismiss with Escape, and move focus
   away. Verify normal task/Hide interaction and outside-click dismissal still work.
   Click the popup header, ancestors, selected task, children and padding; each
   click should open the same task destination exactly once and dismiss the popup.
   Check regular pages, configured journal titles and UUID block links. Verify
   Enter/Space activation, hover/focus feedback, wheel scrolling and thumb dragging.
5. Refresh, close the menu, and disable during debounce, lookup and display.
   Check for orphan actors, modal grabs, callbacks, subprocesses and Shell errors.
6. Delete a source or make the backend unavailable; check controlled error
   presentation and cleanup.

The GJS regression uses a real `Graphene.Rect` with doubled actor sizing. Node
regressions cover the lifecycle and rendering decisions. Neither establishes
live Shell pointer, grab, theme, allocation or accessibility behavior.
