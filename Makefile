.PHONY: run test bundle serve demo clean help

help:
	@echo "lectern"
	@echo "  make run     open index.html in your browser (no build, no server)"
	@echo "  make test    run the test suite (node --test)"
	@echo "  make serve   serve on 127.0.0.1:8173, if file:// is blocked"
	@echo "  make bundle  regenerate demo-data.js from demo/*.c"
	@echo "  make demo    build and run the demo C program itself"

# Open the app. There is nothing to compile: index.html loads core.js, app.js
# and demo-data.js as plain scripts straight off the filesystem.
run:
	@if command -v xdg-open >/dev/null 2>&1; then xdg-open index.html; \
	elif command -v open >/dev/null 2>&1; then open index.html; \
	elif command -v start >/dev/null 2>&1; then start index.html; \
	else echo "Open index.html in your browser."; fi

test:
	node --test test/*.test.js

serve:
	node tools/serve.js

bundle:
	node tools/bundle-demo.js

# The demo codebase is a working program, not a fixture dressed up as one.
# This target proves it: compile it and round-trip some JSON through it.
demo:
	cc -std=c11 -Wall -Wextra -O2 -o /tmp/jsonfmt demo/arena.c demo/json.c demo/main.c
	@echo '{"name":"lectern","tags":["c","reading"],"depth":{"max":64},"ok":true}' \
		| /tmp/jsonfmt

clean:
	rm -f /tmp/jsonfmt
