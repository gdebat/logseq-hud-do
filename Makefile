.PHONY: test benchmark check

test:
	python3 -m unittest discover -s tests -v

benchmark:
	PYTHONPATH=. python3 scripts/benchmark.py

check:
	python3 -m compileall -q logseq_hud_do tests scripts/benchmark.py
	sh -n scripts/install.sh

.PHONY: test-extension check-extension
test-extension:
	gjs -m tests/extension.mjs
	gjs -m tests/preview-position.mjs
	node tests/extension-regressions.mjs
	node tests/extension-ui.mjs
	node tests/extension-prefs.mjs
	python3 -m unittest discover -s tests -p 'test_extension*.py' -v

check-extension:
	glib-compile-schemas --strict --dry-run extension/schemas
	node --input-type=module --check < extension/extension.js
	node --input-type=module --check < extension/prefs.js
	node --input-type=module --check < extension/model.js
	sh -n scripts/install-extension.sh
