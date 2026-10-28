# ios-sim-kit: a CLI (ios-sim) and a Claude skill for driving iOS Simulators without the user's mouse.
#
# Production copy (what other projects and Claude sessions use), written only by `make install`:
#   ~/.local/share/ios-sim-kit/   code + VERSION
#   ~/bin/ios-sim                 wrapper (pinned node → the copy above)
#   ~/.config/ios-sim-kit/        config.json (optional; never overwritten)
#   ~/.claude/skills/ios-sim/     the skill, pointing at ~/bin/ios-sim
# Dev copy, for experiments in this repo: ./bin/ios-sim (config in ./dev/) and `make dev-skill`, a project-only skill
# named ios-sim-dev that points at ./bin/ios-sim. Neither touches the production copy.

NODE_VERSION := $(shell cat .nvmrc)
NODE_BIN     := $(HOME)/.nvm/versions/node/v$(NODE_VERSION)/bin
NODE         := $(NODE_BIN)/node
NPM          := $(NODE_BIN)/npm
# Pinned node leads PATH so npm scripts and shebangs use it.
export PATH  := $(NODE_BIN):$(PATH)
TSC          := node_modules/.bin/tsc
BIOME        := node_modules/.bin/biome
REPO         := $(CURDIR)
BIN_DIR      := $(HOME)/bin
KIT_DIR      := $(HOME)/.local/share/ios-sim-kit
CONFIG_DIR   := $(HOME)/.config/ios-sim-kit
SKILL_DIR    := $(HOME)/.claude/skills/ios-sim
DEV_SKILL    := $(REPO)/.claude/skills/ios-sim-dev

.PHONY: help check-node setup add-dev typecheck lint fmt test e2e check install verify-install uninstall verify-uninstall dev-skill status

help:
	@echo "make setup       npm ci with the pinned node (dev tools: tsc, biome)"
	@echo "make check       typecheck + lint + unit tests"
	@echo "make e2e         the opt-in device test on the sk-* simulators (IOS_SIM_E2E=1)"
	@echo "make fmt         biome --write"
	@echo "make install     check, install ios-sim + the skill (see the top of this Makefile), then verify-install"
	@echo "make verify-install  fail if the installed copy refers to this repo; run it from / without the repo"
	@echo "make uninstall   stop the installed relay; remove the installed copy, skill and state (keeps config.json)"
	@echo "make dev-skill   write the ios-sim-dev skill into this repo's .claude/skills (points at ./bin/ios-sim)"
	@echo "make status      installed version vs this repo"

check-node:
	@test -x "$(NODE)" || { echo "missing node $(NODE_VERSION): nvm install $(NODE_VERSION)"; exit 1; }
	@v=$$("$(NODE)" --version); test "$$v" = "v$(NODE_VERSION)" || { echo "expected v$(NODE_VERSION), got $$v"; exit 1; }

setup: check-node
	"$(NPM)" ci

# Add/upgrade dev dependencies with the pinned node: make add-dev DEPS="pkg@1.2.3 ..."
add-dev: check-node
	"$(NPM)" install --save-dev --save-exact $(DEPS)

typecheck: check-node
	$(TSC) --noEmit -p tsconfig.json

lint: check-node
	$(BIOME) check .

fmt: check-node
	$(BIOME) check --write .

test: check-node
	"$(NODE)" --test 'test/*.test.ts'

# Drives the sk-* simulators through ./bin/ios-sim; takes a few minutes and needs no input.
e2e: check-node
	IOS_SIM_E2E=1 "$(NODE)" --test --test-timeout=900000 test/e2e.test.ts

check: typecheck lint test

install: check
	rm -rf "$(KIT_DIR).new"
	mkdir -p "$(KIT_DIR).new" "$(BIN_DIR)" "$(CONFIG_DIR)" "$(SKILL_DIR)"
	cp -R src "$(KIT_DIR).new/"
	git describe --always --dirty --tags > "$(KIT_DIR).new/VERSION" 2>/dev/null || echo unversioned > "$(KIT_DIR).new/VERSION"
	rm -rf "$(KIT_DIR)"
	mv "$(KIT_DIR).new" "$(KIT_DIR)"
	printf '#!/bin/bash\nexec "$$HOME/.nvm/versions/node/v%s/bin/node" "$$HOME/.local/share/ios-sim-kit/src/cli.ts" "$$@"\n' \
		"$(NODE_VERSION)" > "$(BIN_DIR)/ios-sim"
	chmod +x "$(BIN_DIR)/ios-sim"
	sed -e 's|@SKILL_NAME@|ios-sim|g' -e 's|@IOS_SIM@|$(BIN_DIR)/ios-sim|g' -e 's|@KIT@|$(KIT_DIR)|g' \
		skill/SKILL.md > "$(SKILL_DIR)/SKILL.md"
	@echo "installed $$(cat "$(KIT_DIR)/VERSION"): $(BIN_DIR)/ios-sim, $(SKILL_DIR)/SKILL.md"
	@$(MAKE) --no-print-directory verify-install

# The installed copy must work with this repo gone: nothing installed may name it, and the CLI must run from /.
verify-install:
	@! grep -rn "ws/ios-sim-kit" "$(KIT_DIR)" "$(SKILL_DIR)" "$(BIN_DIR)/ios-sim" || { echo "installed files refer to the repo"; exit 1; }
	@cd / && "$(BIN_DIR)/ios-sim" help > /dev/null && "$(BIN_DIR)/ios-sim" version > /dev/null
	@echo "verify-install: ok (no references to the repo; runs from /)"

# Removes what make install (and the installed CLI at run time) created: a running relay, the code, the wrapper, the
# skill, and state in ~/.config/ios-sim-kit. Keeps a config.json there (user-written) and feedback/ (reports not yet
# picked up), and never touches axe-patched.
uninstall:
	@port=$$(sed -n 's/.*"probePort": *\([0-9]*\).*/\1/p' "$(CONFIG_DIR)/config.json" 2>/dev/null); \
	pid=$$(curl -s --max-time 1 "http://127.0.0.1:$${port:-4320}/" | sed -n 's/.*"probe":"ios-sim","pid":\([0-9]*\).*/\1/p'); \
	if [ -n "$$pid" ]; then kill "$$pid" && echo "stopped the probe relay (pid $$pid)"; sleep 0.3; fi
	rm -rf "$(KIT_DIR)" "$(KIT_DIR).new" "$(SKILL_DIR)"
	@if [ -e "$(BIN_DIR)/ios-sim" ] && ! grep -qs "ios-sim-kit/src/cli.ts" "$(BIN_DIR)/ios-sim"; then \
		echo "left $(BIN_DIR)/ios-sim alone: make install didn't write it"; else rm -f "$(BIN_DIR)/ios-sim"; fi
	rm -rf "$(CONFIG_DIR)/cal" "$(CONFIG_DIR)/shots"
	rm -f "$(CONFIG_DIR)/relay.json" "$(CONFIG_DIR)/history.jsonl" "$(CONFIG_DIR)/history.jsonl.new"
	@rmdir "$(CONFIG_DIR)" 2>/dev/null || echo "kept $(CONFIG_DIR) (config.json, feedback/; delete by hand if unwanted)"
	@$(MAKE) --no-print-directory verify-uninstall

# Fails if anything make install is responsible for is still there (a kept config.json or feedback/ is fine).
verify-uninstall:
	@left=""; for f in "$(KIT_DIR)" "$(KIT_DIR).new" "$(SKILL_DIR)" "$(CONFIG_DIR)/cal" "$(CONFIG_DIR)/shots" \
		"$(CONFIG_DIR)/relay.json" "$(CONFIG_DIR)/history.jsonl"; do [ -e "$$f" ] && left="$$left $$f"; done; \
	grep -qs "ios-sim-kit/src/cli.ts" "$(BIN_DIR)/ios-sim" && left="$$left $(BIN_DIR)/ios-sim"; \
	port=$$(sed -n 's/.*"probePort": *\([0-9]*\).*/\1/p' "$(CONFIG_DIR)/config.json" 2>/dev/null); \
	curl -s --max-time 1 "http://127.0.0.1:$${port:-4320}/" | grep -q '"probe":"ios-sim"' && left="$$left relay:$${port:-4320}"; \
	if [ -n "$$left" ]; then echo "verify-uninstall: still there:$$left"; exit 1; fi
	@test -x "$(HOME)/bin/axe-patched" && echo "verify-uninstall: ok (axe-patched untouched)" || echo "verify-uninstall: ok"

dev-skill:
	mkdir -p "$(DEV_SKILL)" dev
	test -f dev/config.json || echo '{"prefix": "sk", "probePort": 4321}' > dev/config.json
	sed -e 's|@SKILL_NAME@|ios-sim-dev|g' -e 's|@IOS_SIM@|$(REPO)/bin/ios-sim|g' -e 's|@KIT@|$(REPO)|g' \
		skill/SKILL.md > "$(DEV_SKILL)/SKILL.md"
	@echo "wrote $(DEV_SKILL)/SKILL.md (in this repo prefer ios-sim-dev over the installed ios-sim)"

status:
	@echo "repo:      $$(git describe --always --dirty --tags 2>/dev/null || echo 'no commits')"
	@echo "installed: $$(test -x "$(BIN_DIR)/ios-sim" && "$(BIN_DIR)/ios-sim" version || echo 'not installed')"
