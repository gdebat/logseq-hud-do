.PHONY: test benchmark check

test:
	python3 -m unittest discover -s tests -v

benchmark:
	PYTHONPATH=. python3 scripts/benchmark.py

check:
	python3 -m compileall -q logseq_hud_do tests scripts/benchmark.py
	sh -n scripts/install.sh
