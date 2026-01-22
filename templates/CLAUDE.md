# CLAUDE.md — BMAD Orchestration (MCP)

This template defines the canonical BMAD workflow phases, startup routine, and mapped commands/tools.

## Startup (Project Status)
- Preferred single call: `bmad.get_project_status({ project_id, name?, root_path?, config? })`
- Fallback sequence:
  1) `bmad.register_project({ id, name, root_path })`
  2) `bmad.get_project_context({ project_id })`
  3) `bmad.get_sprint_status({ project_id })`
  4) `bmad.list_research_sessions({ project_id })`
  5) `bmad.list_epics({ project_id })` + `bmad.list_stories({ project_id })`

## Canonical Phases

### Phase 1 — Discovery (Optional)
- Brainstorm/Research:
  - Start: `bmad.start_research_session({ project_id, topic })`
  - Note: `bmad.add_research_note({ session_id, type, content, tags })`
  - List: `bmad.list_research_notes({ session_id })`
- Product Brief (optional):
  - New: `bmad.docNewVersion({ project_id, type: 'product_brief', version, content })`
  - Switch: `bmad.switchDocVersion({ project_id, type: 'product_brief', version })`
- Discovery Docs (optional): `bmad.scan_documents({ project_id })`

### Phase 2 — Planning (Required)
- PRD (required): `bmad.prd_new` / `bmad.update_planning_doc({ type:'prd' })`
- UI Decision:
  - If Yes → UX:
    - New: `bmad.ux_new({ project_id, version, content })`
    - Review: `bmad.start_ux_review` → `bmad.approve_ux_review` / `bmad.reject_ux_review`

### Phase 3 — Solutioning (Required)
- Architecture: `bmad.arch_new` → `bmad.switch_arch_version`
- Epics/Stories: `bmad.update_epic`, `bmad.epic_new_version`, `bmad.create_story`
- Test Design (optional): `bmad.create_test_plan`, `bmad.add_test_case`
- Readiness (required): `bmad.start_readiness` → `bmad.update_readiness_item` → `bmad.finalize_readiness`

### Phase 4 — Implementation (Required)
- Sprint Plan: `bmad.set_current_sprint`
- Story Loop:
  - Create/Validate: `bmad.create_story` / `bmad.story_snapshot`
  - Develop: `bmad.update_story_status(in-progress)`, `bmad.reserve_task`, `bmad.add_dev_note`, `bmad.register_files`, `bmad.complete_task`
  - Code Review: `bmad.start_review` → `bmad.add_review_finding` → `bmad.close_review`
  - If rejected → `bmad.add_review_tasks` → back to Develop
  - End conditions: no more stories/epics → retrospective

## Mapping Étape → Commandes
- Discovery:
  - /bmad.research-start → start_research_session
  - /bmad.research-note → add_research_note
  - /bmad.docs-scan → scan_documents
  - /bmad.prd-new (product_brief or prd)
- Planning:
  - /bmad.planning prd|architecture|ux → update_planning_doc / arch_new / ux_new
  - /bmad.set-sprint → set_current_sprint
- Solutioning:
  - /bmad.epic-new-version, /bmad.story-snapshot, /bmad.readiness
- Implementation:
  - /bmad.dev-story, /bmad.code-review, /bmad.review-backlog, /bmad.reserve-task, /bmad.pr

## Rules
- Use MCP tools only; no parsing of exports.
- Respect phases and decisions; do not skip planning steps.
- For multi-agent: always reserve tasks by idx; avoid double assignment.

