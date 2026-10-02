# Makefile — thin wrapper over the npm scripts and docker compose.
#
# This file is a convenience only. The npm scripts in package.json remain the
# source of truth; nothing here adds behaviour that is not reachable with a plain
# `npm run ...`. Use whichever you prefer — both are first-class.
#
#   make            list targets
#   make setup      install, configure, start PostgreSQL, migrate
#   make check      everything CI would run

.DEFAULT_GOAL := help

# bash, not /bin/sh: dash has no `pipefail`, and several targets pipe output.
SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:

# Fail early with a clear message rather than a confusing one later.
ifeq ($(shell docker --version 2>/dev/null),)
$(warning Docker is not installed. Targets 'up', 'down', 'logs' and 'clean' need it)
endif

.PHONY: help
help: ## Show this help
	@echo "FlyRank capstone — available targets"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Full pipeline: make setup && make check && make run"

# --- setup ---------------------------------------------------------------
.PHONY: setup
setup: install env up db-migrate ## First-time setup: install, configure, start database, migrate
	@echo
	@echo "Ready. Start the API with: make run"

.PHONY: install
install: ## Install npm dependencies
	npm install

.PHONY: env
env: .env ## Create .env from .env.example if it does not exist

.env: .env.example
	@cp .env.example .env
	@echo "created .env (gitignored; contains no real secrets)"

# --- database ------------------------------------------------------------
.PHONY: up
up: ## Start PostgreSQL 17 + pgvector in the background
	docker compose up -d
	@echo -n "waiting for PostgreSQL"
	@for i in $$(seq 1 30); do \
		if docker compose exec -T postgres pg_isready -U $${POSTGRES_USER:-postgres} >/dev/null 2>&1; then \
			echo " ready"; exit 0; \
		fi; \
		echo -n "."; sleep 1; \
	done; \
	echo " timed out"; exit 1

.PHONY: down
down: ## Stop the database container (keeps its data)
	docker compose down

.PHONY: logs
logs: ## Follow database logs
	docker compose logs -f

.PHONY: db-migrate
db-migrate: ## Apply pending migrations
	npm run db:migrate

.PHONY: db-rollback
db-rollback: ## Revert the most recent migration (make db-rollback N=3 to revert several)
	npm run db:rollback -- $(or $(N),1)

.PHONY: db-status
db-status: ## Show which migrations are applied
	npm run db:status

# --- application ---------------------------------------------------------
.PHONY: run
run: ## Start the API on http://localhost:3000
	npm start

.PHONY: dev
dev: ## Start the API with auto-reload on src/ changes
	npm run dev

.PHONY: smoke
smoke: ## Exercise every endpoint against a running server
	@curl -fsS localhost:3000/health > /dev/null && echo "GET  /health            ok"
	@curl -fsS localhost:3000/health/ready > /dev/null && echo "GET  /health/ready      ok"
	@curl -fsS -X POST localhost:3000/api/posts \
		-H 'content-type: application/json' \
		-d '{"title":"Smoke Test","content":"created by make smoke"}' > /dev/null \
		&& echo "POST /api/posts         ok"
	@curl -fsS 'localhost:3000/api/posts?limit=1' > /dev/null && echo "GET  /api/posts         ok"
	@echo "all endpoints responded"

# --- tests ---------------------------------------------------------------
.PHONY: test
test: test-unit ## Run the unit tests (no database required)

.PHONY: test-unit
test-unit: ## Run unit tests only — no PostgreSQL needed
	npm test

.PHONY: test-integration
test-integration: ## Run integration tests (requires a migrated database)
	npm run test:integration

.PHONY: test-all
test-all: ## Run unit and integration tests
	npm run test:all

# --- corpus --------------------------------------------------------------
.PHONY: corpus
corpus: corpus-fetch corpus-verify ## Fetch anything missing, then verify integrity and provenance

.PHONY: corpus-fetch
corpus-fetch: ## Download missing corpus images (idempotent)
	npm run corpus:fetch

.PHONY: corpus-verify
corpus-verify: ## Verify hashes, dimensions, licences, provenance and the 40+/4+ targets
	npm run corpus:verify

# --- phase 2: vision pipeline --------------------------------------------
# These call a provider and spend money. They are deliberately separate from
# `make check`, which must stay runnable offline and free.
.PHONY: process
process: ## Analyse every corpus image, embed captions, and report costs
	npm run process:corpus

.PHONY: process-dry
process-dry: ## Show what a corpus run would do. No provider calls, no cost
	npm run process:corpus -- --dry-run

.PHONY: costs
costs: ## Show AI spend per provider/model/operation and budget status
	npm run costs

# --- verification --------------------------------------------------------
# The same set CI runs. 'make check' is the single command that proves Phase 1.
.PHONY: check
check: db-status test-all corpus-verify ## Run the full verification suite
	@echo
	@echo "Phase 1 verification complete."

.PHONY: eval
eval: ## Measure top-1 precision (Phase 4 — not implemented yet)
	@echo "Evaluation is not implemented yet; it lands in Phase 4." >&2
	@echo "No precision figure exists. See EVIDENCE.md and README.md." >&2
	@exit 1

# --- housekeeping --------------------------------------------------------
.PHONY: clean
clean: ## Stop containers and remove node_modules (keeps database data)
	docker compose down --remove-orphans || true
	rm -rf node_modules
	@echo "removed node_modules; run 'make install' to restore"

.PHONY: distclean
distclean: ## DESTRUCTIVE: also delete the database volume and all local data
	@printf 'This deletes the PostgreSQL volume and ALL local data. Type yes to continue: '
	@read -r answer; [ "$$answer" = "yes" ] || { echo "aborted"; exit 1; }
	docker compose down --volumes --remove-orphans
	rm -rf node_modules