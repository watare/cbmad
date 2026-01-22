# CLAUDE.md — BMAD Orchestration (MCP)

Canonical BMAD phases, startup routine, workflow runner usage, and exact tool mappings. Use MCP tools only; no file parsing.

## Startup (Status First)
- Primary: `bmad.get_project_status({ project_id, name?, root_path?, config? })` → context, sprint, discovery, planning_flags.
- If missing project: `bmad.register_project({ id, name, root_path })` then status.

## Workflow Runner (Low‑Token)
- Discover: `bmad.list_workflows({ project_id })` (use `bmad.list_optional_workflows` to propose optionals).
- Open: `bmad.open_workflow({ project_id, code })`.
- Next step: `bmad.next_step({ project_id, code, cursor })` (cursor++ to advance). YAML treated as whole until advanced parsing lands.
- Save interim outputs: `bmad.save_workflow_output({ project_id, code, title?, content, tags? })`.
- Mapping reference: `bmad.generate_workflow_mapping({ project_id })`.

## Phases & Tools

### Phase 1 — Discovery (Optional)
- Research: `bmad.start_research_session({ project_id, topic })` → `bmad.add_research_note` → `bmad.list_research_notes`.
- Docs index/search: `bmad.scan_documents({ project_id })`, `bmad.search_documents`, `bmad.get_document` (prefer summaries).
- Product Brief (optional):
  - Persist: `bmad.update_planning_doc({ project_id, type: 'product_brief', content, generate_summary: true })`.
  - Versioning: `bmad.product_brief_new` / `bmad.get_product_brief_versions` / `bmad.switch_product_brief_version`.

### Phase 2 — Planning (Required)
- PRD: `bmad.prd_new({ project_id, version, content })` and/or `bmad.update_planning_doc({ type: 'prd' })`.
- Architecture: `bmad.arch_new` / `bmad.get_arch_versions` / `bmad.switch_arch_version`.
- UX: `bmad.ux_new` + `bmad.start_ux_review` → `bmad.approve_ux_review`/`bmad.reject_ux_review`.
- Question Gate (before UX or Design):
  - Ensure clarifying questions are asked and answered:
    - Create a session: `bmad.start_research_session({ project_id, topic: 'Clarifying Questions' })`
    - Add questions as notes: `bmad.add_research_note({ session_id, type: 'question', content })`
    - When done: `bmad.set_phase_gate({ project_id, gate_key: 'ux_clarifications', status: 'answered', notes: 'summary' })` (or `waived` with rationale)
- Other optionals (persist via update_planning_doc; version via *_new/get_*_versions/switch_*_version):
  - NFR: `nfr`
  - Test Design: `test_design`
  - ATDD: `atdd`
  - Traceability: `traceability`
  - CI Plan: `ci_plan`
  - Tech Spec (Quick Spec): `tech_spec`

### Phase 3 — Solutioning (Required)
- Epics: `bmad.update_epic`, `bmad.epic_new_version`, `bmad.get_epic_versions`, `bmad.switch_epic_version`.
- Stories: `bmad.create_story`, `bmad.update_story`, `bmad.story_snapshot`, `bmad.get_story_versions`, `bmad.switch_story_version`.
- Readiness (gate): `bmad.start_readiness` → `bmad.update_readiness_item` → `bmad.finalize_readiness`.

### Phase 4 — Implementation (Required)
- Sprint: `bmad.set_current_sprint`, `bmad.get_sprint_status`, `bmad.sprint_planning_generate`.
- Story loop:
  - Context: `bmad.get_next_story` / `bmad.get_story_context`.
  - Dev: `bmad.update_story_status`, `bmad.reserve_task`, `bmad.add_dev_note`, `bmad.register_files`, `bmad.complete_task`.
  - Review: `bmad.start_review` → `bmad.add_review_finding` → `bmad.close_review`; backlog: `bmad.get_review_backlog` + follow‑ups `bmad.add_review_tasks`/`bmad.complete_review_item`/`bmad.bulk_complete_review`.
  - Exports on demand: `bmad.generate_pr` / `bmad.export_pr_md`, `bmad.export_story_md`, `bmad.export_project_md`.
- Retrospective: `bmad.retro_log`.

## Step → Commands (Examples)
- Discovery: /bmad.research-start → start_research_session; /bmad.docs-scan → scan_documents; /bmad.brief → update_planning_doc(type:'product_brief').
- Planning: /bmad.prd → prd_new or update_planning_doc(type:'prd'); /bmad.arch → arch_new; /bmad.ux → ux_new; optionals map to respective types.
- Solutioning: /bmad.epic-version, /bmad.story-snapshot, /bmad.readiness.
- Implementation: /bmad.dev-story, /bmad.code-review, /bmad.review-backlog, /bmad.reserve-task, /bmad.pr.

## Rules (Token Discipline)
- Use `bmad.next_step` for current section only; avoid full‑file loads.
- Prefer summaries (`bmad.get_planning_doc({ format:'summary' })`, `bmad.get_document({ format:'summary' })`) before fetching full content.
- Persist via MCP set calls; do not write repo Markdown unless explicitly exporting.
- In multi‑agent contexts, reserve tasks (`bmad.reserve_task`) and use `precondition_updated_at` on planning updates.
- Question Gate (before readiness):
  - Verify non-functional and test design clarifications captured:
    - `bmad.set_phase_gate({ project_id, gate_key: 'nfr_questions', status: 'answered'|'waived', notes? })`
    - `bmad.set_phase_gate({ project_id, gate_key: 'test_design_questions', status: 'answered'|'waived', notes? })`
- Do not design UX solely from PRD without a questions gate; record at least 5 clarifying questions or explicitly waive with rationale via `bmad.set_phase_gate`.
