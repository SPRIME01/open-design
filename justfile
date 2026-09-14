# Open Design demo app recipes.
#
# Builds and removes the examples/kanban demo application through the real
# application-compiler pipeline (CLI -> daemon HTTP -> 9-pass compile) using an
# isolated tools-dev runtime: its own namespace (kanban-demo), its own daemon
# port (17520), and its own daemon data root (.tmp/kanban-demo-data), so it
# never touches a developer's running runtime or data.
#
# Requires a bootstrapped repository (pnpm install + built daemon dist) and
# `just` on PATH. See examples/kanban/README.md.

# Where the built demo lives (html-static preview + sqlite persistence output).
demo-path:
	@echo "examples/kanban/generated/html-static (static board preview)"
	@echo "examples/kanban/generated/sqlite-better-sqlite3 (sqlite persistence output)"

# Build the kanban demo app through the real daemon compiler flow.
demo-build:
	#!/usr/bin/env sh
	set -eu
	DAEMON_URL="http://127.0.0.1:17520"
	if curl -fsS --max-time 2 "$DAEMON_URL/api/compiler/targets" >/dev/null 2>&1; then
		echo "kanban-demo daemon already reachable at $DAEMON_URL"
	else
		echo "Starting isolated kanban-demo daemon (namespace kanban-demo, port 17520)..."
		OD_DATA_DIR="$PWD/.tmp/kanban-demo-data" \
			pnpm tools-dev --namespace kanban-demo start daemon --daemon-port 17520
		i=0
		while [ "$i" -lt 60 ]; do
			if curl -fsS --max-time 2 "$DAEMON_URL/api/compiler/targets" >/dev/null 2>&1; then
				break
			fi
			i=$((i + 1))
			sleep 1
		done
		if [ "$i" -ge 60 ]; then
			echo "ERROR: kanban-demo daemon did not become ready within 60s" >&2
			exit 1
		fi
	fi
	echo "Compiling examples/kanban -> html-static..."
	OD_DAEMON_URL="$DAEMON_URL" node apps/daemon/bin/od.mjs app compile \
		--project examples/kanban --target html-static
	echo "Compiling examples/kanban -> sqlite-better-sqlite3..."
	OD_DAEMON_URL="$DAEMON_URL" node apps/daemon/bin/od.mjs app compile \
		--project examples/kanban --target sqlite-better-sqlite3
	echo ""
	echo "Kanban demo built:"
	echo "  examples/kanban/generated/html-static/index.html"
	echo "  examples/kanban/generated/sqlite-better-sqlite3/"

# Remove the built demo app and its isolated runtime.
demo-remove:
	#!/usr/bin/env sh
	set -eu
	pnpm tools-dev --namespace kanban-demo stop
	rm -rf examples/kanban/generated examples/kanban/compiler .tmp/kanban-demo-data
	echo "Removed examples/kanban/generated, examples/kanban/compiler, .tmp/kanban-demo-data"
	echo "Stopped the kanban-demo namespace runtime"
