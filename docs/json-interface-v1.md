# JSON interface v1

Version 1 is the current CLI stdout contract, shared by the bundled backend and
extension. The version is the contract revision, not a new response field.
Incompatible vocabulary or field changes require a new contract revision and
coordinated producer/consumer changes. No runtime negotiation is performed.

Successful stdout is one JSON object with category arrays `today`, `overdue`,
`upcoming`, in that display order. Every task has `id`, `content`, `status`,
`priority`, `graph`, `source_file`, `source_page`, `journal_date`,
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
