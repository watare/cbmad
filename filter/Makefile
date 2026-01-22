PROJECT_ROOT := $(CURDIR)

.PHONY: bmad-init bmad-export

bmad-init:
	@bmad-mcp project-init || npx bmad-mcp project-init
	@bmad-mcp register-project || npx bmad-mcp register-project
	@echo "Initialized and registered BMAD project in $(PROJECT_ROOT)"

bmad-export:
	@# Exports are invoked from Claude via MCP; this is a helper example only.
	@echo "Use bmad.export_project_md from Claude to generate _bmad-output."
