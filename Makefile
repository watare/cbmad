PREFIX ?= $(HOME)/.config/bmad-server
LOCALBIN ?= $(HOME)/.local/bin

.PHONY: install install-local uninstall db-backup db-vacuum claude-md schema cli-link

install: install-local claude-md schema cli-link
	@echo "BMAD MCP installed. Run: bmad-mcp doctor"

install-local:
	mkdir -p $(PREFIX)/db $(PREFIX)/schemas $(PREFIX)/exports
	mkdir -p $(HOME)/.claude
	node -e "const fs=require('fs'),p=process.env.HOME+'/.claude/mcp-servers.json';let j={};if(fs.existsSync(p)){try{j=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){}};j.bmad={command:'node',args:['$(PWD)/src/server.js'],env:{BMAD_DB_PATH:'$(PREFIX)/db/bmad.sqlite',BMAD_LOG_LEVEL:'info',BMAD_EXPORT_DIR:'$(PREFIX)/exports'}};fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('Wrote',p);"
	@touch $(PREFIX)/db/bmad.sqlite
	@echo "Installed to $(PREFIX)"

claude-md:
	mkdir -p $(HOME)/.claude
	@# Append or write central CLAUDE.md if missing
	@if [ ! -f $(HOME)/.claude/CLAUDE.md ]; then \
	  echo "Writing $(HOME)/.claude/CLAUDE.md"; \
	  node -e "const fs=require('fs');const p=process.env.HOME+'/.claude/CLAUDE.md';fs.writeFileSync(p, '# CLAUDE.md — BMAD (MCP) Central Orchestration\n\nSee server README for full workflows.');"; \
	fi
	@# Ensure commands section exists (idempotent simple check)
	@grep -q "Commandes /bmad" $(HOME)/.claude/CLAUDE.md || \
	  echo "\n## Commandes /bmad (rétro‑compatibles)\n(voir README du serveur, les commandes sont mappées vers bmad.*)" >> $(HOME)/.claude/CLAUDE.md

schema:
	@# Generate MCP schema bundle without starting server
	mkdir -p $(PREFIX)/schemas
	node -e "const fs=require('fs'); const p='$(PREFIX)/schemas/mcp.schema.json'; const b=require('./src/schema').asBundle(); fs.writeFileSync(p, JSON.stringify(b,null,2)); console.log('Wrote', p);"

cli-link:
	@# Create a convenience shim in ~/.local/bin if available
	@if [ -d $(LOCALBIN) ]; then \
	  echo '#!/usr/bin/env bash' > $(LOCALBIN)/bmad-mcp; \
	  echo 'node $(PWD)/bin/bmad-mcp.js "$$@"' >> $(LOCALBIN)/bmad-mcp; \
	  chmod +x $(LOCALBIN)/bmad-mcp; \
	  echo 'Created $(LOCALBIN)/bmad-mcp'; \
	else \
	  echo 'Note: $(LOCALBIN) not found. Use npx or add a PATH shim manually.'; \
	fi

uninstall:
	rm -f $(PREFIX)/server.js
	@echo "Removed server.js (DB preserved)"

db-backup:
	mkdir -p $(PREFIX)/db
	cp -f $(PREFIX)/db/bmad.sqlite $(PREFIX)/db/backup-$$(date +%Y%m%d%H%M).sqlite
	@echo "Backup created"

db-vacuum:
	node -e "const DB=require('better-sqlite3'); const db=new DB('$(PREFIX)/db/bmad.sqlite'); db.prepare('VACUUM').run(); console.log('VACUUM done');"
