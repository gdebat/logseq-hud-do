# OG navigation verification

The previous correction used source filename stems as page names. This fails
for journals (`2026_10_31` versus `Oct 31st, 2026`), namespace filenames and
escaped filenames. The backend now resolves titles before building the URI;
explicit page `title::` wins, otherwise default OG journal titles and decoded
triple-underscore namespace filenames are used. Custom journal title formats
remain unsupported; validate those against a copied Logseq link before use.
UUIDs come only from task-owned `id::` properties, never task hash identifiers.
A syntactically valid stored UUID cannot prove the block exists in Logseq's index.

Official references verified against OG 0.10.9:

- [Protocol formats](https://github.com/logseq/docs/blob/master/pages/Logseq%20Protocol.md)
- [URI decoding and routing](https://github.com/logseq/logseq/blob/0.10.9/src/electron/electron/url.cljs)
- [Graph identifier suffix lookup](https://github.com/logseq/logseq/blob/0.10.9/src/electron/electron/handler.cljs#L238)
- [Journal title formatting](https://github.com/logseq/logseq/blob/0.10.9/src/main/frontend/date.cljs)

Graph resolution uses the canonical directory basename, not the display alias.
Logseq must already have that directory linked. Duplicate basenames are ambiguous;
the backend cannot verify Logseq's linked graph registry. Compare the identifier
with Logseq's own copied URL, especially after renaming or symlinking a graph.

## Manual acceptance (not performed by automated tests)

1. In Logseq OG create a disposable graph, link it, and configure that same
   directory in HUD with a deliberately different display alias. Do not use a
   real graph for acceptance. Record Logseq and GNOME versions.
2. Create scheduled TODOs on a journal, a page with spaces, a namespace page,
   and a page containing Unicode, `&`, `?`, `#`, and `%`. Copy page URLs from
   Logseq and compare their decoded graph/page targets with CLI output from
   `python3 -m logseq_hud_do --graph /disposable/graph --cache /tmp/hud-test.sqlite --diagnostics`.
   Diagnostics on stderr list canonical graph path, identifier, source file,
   resolved page, block reference status (valid/invalid/missing), target and URI.
3. Use Logseq's Copy block URL action to obtain a genuine persisted block UUID.
   Confirm its `id::` in the disposable Markdown and compare the backend URI
   with the copied URL. Click that row: verify the exact block, not just graph.
   For a task without `id::`, verify the originating page opens. Test an invalid
   `id::` in the disposable fixture and verify page fallback diagnostics.
4. Check `xdg-mime query default x-scheme-handler/logseq`. Open the exact JSON
   URI via `gio open 'URI'`, then via the HUD row. If both reach the wrong graph,
   compare the graph identifier with the copied link and linked directories.
   If the graph is right but page wrong, compare resolved page/title and journal
   format. If only block fails, check persisted UUID and reindex in Logseq.
5. Test with Logseq running and stopped. In an isolated desktop profile test
   missing protocol registration and a broken desktop handler. HUD must report
   registration missing separately from URI activation failure. Gio completion
   confirms desktop activation only; verify destination visually in Logseq.
6. On GNOME 46–50, under light and dark Shell themes, verify graph/date context
   is slightly muted and readable, descriptions remain full contrast, DOING is
   green, High red, Medium amber, Low blue, and TODO/unprioritized rows have no
   corresponding badge. Verify raw priority markers stay hidden.
7. Disable during pending activation; verify no callback errors in the journal.

Automated tests exercise extraction, warm cache, URL encoding, model contract,
unchanged URI delivery and asynchronous completion/failure with test doubles.
They do not establish live navigation or theme readability.
