/*
  BMAD MCP Server (Node.js, CommonJS)
  - SQLite backend (better-sqlite3)
  - Minimal set of MCP tools implemented per spec
*/
const path = require('path');
const os = require('os');
const fs = require('fs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');
let Types = null;
try {
  Types = require('@modelcontextprotocol/sdk/types');
} catch (e) {
  // Older SDKs may not expose CJS subpath exports for /types; degrade gracefully.
  // Resource handlers will be skipped if Types is unavailable.
}

const tools = require('./tools');
const SCHEMA = require('./schema');

function getEnv(key, def) {
  const v = process.env[key];
  return v && v.length ? v : def;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function resolvePaths() {
  const configRoot = path.join(os.homedir(), '.config', 'bmad-server');
  const dbPath = expandHome(getEnv('BMAD_DB_PATH', path.join(configRoot, 'db', 'bmad.sqlite')));
  const exportDir = expandHome(getEnv('BMAD_EXPORT_DIR', path.join(configRoot, 'exports')));
  const logLevel = getEnv('BMAD_LOG_LEVEL', 'info');
  return { dbPath, exportDir, logLevel };
}

async function main() {
  const { dbPath, exportDir, logLevel } = resolvePaths();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  const mcp = new McpServer({ name: 'bmad-mcp-server', version: '0.1.0' });
  const anyArgs = z.object({}).passthrough();
  const wrap = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  // Guard against duplicate registrations (defensive in addition to SDK checks)
  const originalRegisterTool = mcp.registerTool.bind(mcp);
  const registeredTools = new Set();
  mcp.registerTool = (name, config, handler) => {
    if (registeredTools.has(name)) {
      if (logLevel !== 'silent') {
        console.error('[bmad-mcp] duplicate tool ignored:', name);
      }
      return;
    }
    registeredTools.add(name);
    return originalRegisterTool(name, config, handler);
  };
  const withDb = (fn) => async (args, extra) => {
    let db;
    try {
      const { getDb, migrate } = require('./store/db');
      db = getDb(dbPath);
      migrate(db);
    } catch (e) {
      return wrap({ success: false, error: 'DB initialization failed', detail: String(e && e.message || e) });
    }
    try {
      const out = await fn(db, args, extra);
      return wrap(out);
    } catch (e) {
      return wrap({ success: false, error: String(e && e.message || e) });
    }
  };

  // Project Management
  mcp.registerTool('bmad.register_project', { description: 'Register or update a BMAD project', inputSchema: anyArgs }, withDb((db, input) => tools.registerProject(db, input)));

  mcp.registerTool('bmad.get_project_context', { description: 'Get project summary context', inputSchema: anyArgs }, withDb((db, input) => tools.getProjectContext(db, input)));
  mcp.registerTool('bmad.get_project_status', { description: 'Composite project status (context + sprint + discovery + flags)', inputSchema: anyArgs }, withDb((db, input) => tools.getProjectStatus(db, input)));
  mcp.registerTool('bmad.workflow_init', { description: 'Initialize project (register, sprint, docs, seed PRD/Arch/UX)', inputSchema: anyArgs }, withDb((db, input) => tools.workflowInit(db, input)));
  // BMAD-METHOD installer & runner
  mcp.registerTool('bmad.install_bmad_method', { description: 'Install BMAD-METHOD workflows into project', inputSchema: anyArgs }, withDb((db, input) => tools.installBmadMethod(db, input)));
  mcp.registerTool('bmad.list_workflows', { description: 'List BMAD workflows (from module-help.csv)', inputSchema: anyArgs }, withDb((db, input) => tools.listWorkflows(db, input)));
  mcp.registerTool('bmad.list_optional_workflows', { description: 'List optional BMAD workflows (from module-help.csv)', inputSchema: anyArgs }, withDb((db, input) => tools.listOptionalWorkflows(db, input)));
  mcp.registerTool('bmad.open_workflow', { description: 'Open a workflow by code', inputSchema: anyArgs }, withDb((db, input) => tools.openWorkflow(db, input)));
  mcp.registerTool('bmad.next_step', { description: 'Get next workflow step by index (simple splitter)', inputSchema: anyArgs }, withDb((db, input) => tools.nextStep(db, input)));
  mcp.registerTool('bmad.generate_workflow_mapping', { description: 'Generate quick reference mapping from module-help.csv', inputSchema: anyArgs }, withDb((db, input) => tools.generateWorkflowMapping(db, input)));

  // MCP Resources: expose installed workflows for browsing
  try {
    if (Types && Types.ListResourcesRequestSchema && Types.ReadResourceRequestSchema) {
      mcp.server.registerCapabilities({ resources: { listChanged: true } });
      mcp.server.setRequestHandler(Types.ListResourcesRequestSchema, (request) => {
        const items = [];
        const home = os.homedir();
        const globalBase = path.join(home, '.config', 'bmad-server', 'bmm', 'workflows');
        function walk(root, baseUri) {
          if (!fs.existsSync(root)) return;
          for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
            const p = path.join(root, dirent.name);
            if (dirent.isDirectory()) walk(p, baseUri + '/' + dirent.name);
            else {
              const ext = path.extname(dirent.name).toLowerCase();
              const mime = ext === '.md' ? 'text/markdown' : (ext === '.yaml' || ext === '.yml' ? 'text/yaml' : 'text/plain');
              items.push({ uri: `bmad://workflows${baseUri}/${dirent.name}`, name: dirent.name, mimeType: mime, description: 'BMAD workflow asset' });
            }
          }
        }
        walk(globalBase, '');
        return { resources: items };
      });
      mcp.server.setRequestHandler(Types.ReadResourceRequestSchema, (request) => {
        const uri = request.params.uri || '';
        if (!uri.startsWith('bmad://workflows')) throw new Error('Unsupported URI');
        const rel = uri.replace('bmad://workflows', '');
        const p = path.join(os.homedir(), '.config', 'bmad-server', 'bmm', 'workflows', rel);
        if (!fs.existsSync(p)) throw new Error('Not found');
        const ext = path.extname(p).toLowerCase();
        const mime = ext === '.md' ? 'text/markdown' : (ext === '.yaml' || ext === '.yml' ? 'text/yaml' : 'text/plain');
        const text = fs.readFileSync(p, 'utf8');
        return { contents: [{ uri, mimeType: mime, text }] };
      });
    } else if (logLevel !== 'silent') {
      console.error('[bmad-mcp] @modelcontextprotocol/sdk/types not available; skipping resource handlers');
    }
  } catch (e) {
    if (mcp?.server && logLevel !== 'silent') console.error('[bmad-mcp] resources capability not available:', e.message);
  }

  // Story Management
  mcp.registerTool('bmad.get_next_story', { description: 'Get the next story to develop', inputSchema: anyArgs }, withDb((db, input) => tools.getNextStory(db, input)));

  mcp.registerTool('bmad.get_story_context', { description: 'Get full story context', inputSchema: anyArgs }, withDb((db, input) => tools.getStoryContext(db, input)));

  mcp.registerTool('bmad.get_story_summary', { description: 'Get condensed story summary', inputSchema: anyArgs }, withDb((db, input) => tools.getStorySummary(db, input)));

  mcp.registerTool('bmad.create_story', { description: 'Create a new story', inputSchema: anyArgs }, withDb((db, input) => tools.createStory(db, input)));

  mcp.registerTool('bmad.update_story_status', { description: 'Update story status', inputSchema: anyArgs }, withDb((db, input) => tools.updateStoryStatus(db, input)));

  // Task Management
  mcp.registerTool('bmad.complete_task', { description: 'Mark a task or subtask as completed', inputSchema: anyArgs }, withDb((db, input) => tools.completeTask(db, input)));

  mcp.registerTool('bmad.add_review_tasks', { description: 'Add review follow-up tasks', inputSchema: anyArgs }, withDb((db, input) => tools.addReviewTasks(db, input)));

  // Dev Notes & Files
  mcp.registerTool('bmad.add_dev_note', { description: 'Append development note', inputSchema: anyArgs }, withDb((db, input) => tools.addDevNote(db, input)));

  mcp.registerTool('bmad.register_files', { description: 'Register changed files under a story', inputSchema: anyArgs }, withDb((db, input) => tools.registerFiles(db, input)));

  mcp.registerTool('bmad.add_changelog_entry', { description: 'Append a changelog entry', inputSchema: anyArgs }, withDb((db, input) => tools.addChangelogEntry(db, input)));

  // Planning Documents
  mcp.registerTool('bmad.get_planning_doc', { description: 'Fetch planning doc', inputSchema: anyArgs }, withDb((db, input) => tools.getPlanningDoc(db, input)));

  mcp.registerTool('bmad.update_planning_doc', { description: 'Update planning doc', inputSchema: anyArgs }, withDb((db, input) => tools.updatePlanningDoc(db, input)));

  // Sprint & Workflow
  mcp.registerTool('bmad.get_sprint_status', { description: 'Get sprint status', inputSchema: anyArgs }, withDb((db, input) => tools.getSprintStatus(db, input)));

  mcp.registerTool('bmad.log_action', { description: 'Log orchestration action', inputSchema: anyArgs }, withDb((db, input) => tools.logAction(db, input)));
  mcp.registerTool('bmad.set_current_sprint', { description: 'Set current sprint label for project', inputSchema: anyArgs }, withDb((db, input) => tools.setCurrentSprint(db, input)));

  // Export
  mcp.registerTool('bmad.export_story_md', { description: 'Export a story to Markdown', inputSchema: anyArgs }, withDb((db, input) => tools.exportStoryMd(db, input, { exportDir })));

  mcp.registerTool('bmad.export_project_md', { description: 'Export the project to Markdown files', inputSchema: anyArgs }, withDb((db, input) => tools.exportProjectMd(db, input, { exportDir })));
  mcp.registerTool('bmad.export_pr_md', { description: 'Export a PR markdown for a story', inputSchema: anyArgs }, withDb((db, input) => tools.exportPrMd(db, input, { exportDir })));
  mcp.registerTool('bmad.generate_pr', { description: 'Generate PR title/body for a story', inputSchema: anyArgs }, withDb((db, input) => tools.generatePr(db, input)));
  // Planning docs export (MD/HTML/PDF)
  mcp.registerTool('bmad.export_planning_doc', { description: 'Export a planning doc to md/html/pdf', inputSchema: anyArgs }, withDb((db, input) => tools.exportPlanningDoc(db, input, { exportDir })));
  mcp.registerTool('bmad.export_docs', { description: 'Export multiple planning docs to requested formats', inputSchema: anyArgs }, withDb((db, input) => tools.exportDocs(db, input, { exportDir })));
  mcp.registerTool('bmad.save_workflow_output', { description: 'Save generic output of a workflow step into documents', inputSchema: anyArgs }, withDb((db, input) => tools.saveWorkflowOutput(db, input)));

  // Import
  mcp.registerTool('bmad.import_project', { description: 'Import a legacy BMAD project from files', inputSchema: anyArgs }, withDb((db, input) => tools.importProject(db, input)));

  // Schema Discovery (no DB)
  mcp.registerTool('bmad.get_mcp_schema', { description: 'Return MCP tool schemas (inputs/outputs)', inputSchema: anyArgs }, async () => wrap(SCHEMA.asBundle()));
  // Additional helpers (registered earlier): update_acceptance_criteria, list_stories, list_epics, update_epic, search_stories
  // Admin/story management
  mcp.registerTool('bmad.update_story', { description: 'Update story fields', inputSchema: anyArgs }, withDb((db, input) => tools.updateStory(db, input)));
  mcp.registerTool('bmad.delete_story', { description: 'Delete a story (guarded)', inputSchema: anyArgs }, withDb((db, input) => tools.deleteStory(db, input)));
  mcp.registerTool('bmad.get_epic', { description: 'Get a single epic', inputSchema: anyArgs }, withDb((db, input) => tools.getEpic(db, input)));
  mcp.registerTool('bmad.delete_epic', { description: 'Delete an epic (guarded)', inputSchema: anyArgs }, withDb((db, input) => tools.deleteEpic(db, input)));
  // Labels
  mcp.registerTool('bmad.set_story_labels', { description: 'Set labels for a story', inputSchema: anyArgs }, withDb((db, input) => tools.setStoryLabels(db, input)));
  mcp.registerTool('bmad.list_story_labels', { description: 'List labels for a story', inputSchema: anyArgs }, withDb((db, input) => tools.listStoryLabels(db, input)));
  mcp.registerTool('bmad.search_by_label', { description: 'Search stories by label', inputSchema: anyArgs }, withDb((db, input) => tools.searchByLabel(db, input)));
  // Split/Merge
  mcp.registerTool('bmad.split_story', { description: 'Split a story by moving tasks', inputSchema: anyArgs }, withDb((db, input) => tools.splitStory(db, input)));
  mcp.registerTool('bmad.merge_stories', { description: 'Merge source story into target', inputSchema: anyArgs }, withDb((db, input) => tools.mergeStories(db, input)));
  // Story sprint assignment
  mcp.registerTool('bmad.set_story_sprint', { description: 'Assign a story to a sprint label', inputSchema: anyArgs }, withDb((db, input) => tools.setStorySprint(db, input)));
  mcp.registerTool('bmad.list_stories_by_sprint', { description: 'List stories assigned to a sprint', inputSchema: anyArgs }, withDb((db, input) => tools.listStoriesBySprint(db, input)));
  // Document discovery
  mcp.registerTool('bmad.scan_documents', { description: 'Scan project docs and index in DB', inputSchema: anyArgs }, withDb((db, input) => tools.scanDocuments(db, input)));
  mcp.registerTool('bmad.list_documents', { description: 'List indexed documents', inputSchema: anyArgs }, withDb((db, input) => tools.listDocuments(db, input)));
  mcp.registerTool('bmad.get_document', { description: 'Get one document (summary/full)', inputSchema: anyArgs }, withDb((db, input) => tools.getDocument(db, input)));
  // Research sessions
  mcp.registerTool('bmad.list_research_sessions', { description: 'List research sessions for project', inputSchema: anyArgs }, withDb((db, input) => tools.listResearchSessions(db, input)));
  mcp.registerTool('bmad.search_documents', { description: 'Search indexed documents', inputSchema: anyArgs }, withDb((db, input) => tools.searchDocuments(db, input)));
  // Bugs / Quick Fix
  mcp.registerTool('bmad.create_bug', { description: 'Create a bug ticket', inputSchema: anyArgs }, withDb((db, input) => tools.createBug(db, input)));
  mcp.registerTool('bmad.update_bug_status', { description: 'Update bug status', inputSchema: anyArgs }, withDb((db, input) => tools.updateBugStatus(db, input)));
  mcp.registerTool('bmad.get_bug', { description: 'Get a bug', inputSchema: anyArgs }, withDb((db, input) => tools.getBug(db, input)));
  mcp.registerTool('bmad.list_bugs', { description: 'List bugs', inputSchema: anyArgs }, withDb((db, input) => tools.listBugs(db, input)));
  mcp.registerTool('bmad.link_bug_files', { description: 'Link files to a bug', inputSchema: anyArgs }, withDb((db, input) => tools.linkBugFiles(db, input)));
  mcp.registerTool('bmad.link_bug_story', { description: 'Link bug to a story', inputSchema: anyArgs }, withDb((db, input) => tools.linkBugStory(db, input)));
  mcp.registerTool('bmad.generate_bugfix_pr', { description: 'Generate PR text for a bugfix', inputSchema: anyArgs }, withDb((db, input) => tools.generateBugfixPr(db, input)));
  // PRD versioning
  mcp.registerTool('bmad.prd_new', { description: 'Create a new PRD version and set current', inputSchema: anyArgs }, withDb((db, input) => tools.prdNew(db, input)));
  mcp.registerTool('bmad.get_prd_versions', { description: 'List PRD versions', inputSchema: anyArgs }, withDb((db, input) => tools.getPrdVersions(db, input)));
  mcp.registerTool('bmad.switch_prd_version', { description: 'Switch current PRD to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchPrdVersion(db, input)));
  // Product Brief (optional) versioning
  mcp.registerTool('bmad.product_brief_new', { description: 'Create a new Product Brief version and set current', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'product_brief' })));
  mcp.registerTool('bmad.get_product_brief_versions', { description: 'List Product Brief versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'product_brief' })));
  mcp.registerTool('bmad.switch_product_brief_version', { description: 'Switch Product Brief to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'product_brief' })));
  // Additional optional docs versioning
  mcp.registerTool('bmad.nfr_new', { description: 'Create a new NFR assessment version', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'nfr' })));
  mcp.registerTool('bmad.get_nfr_versions', { description: 'List NFR assessment versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'nfr' })));
  mcp.registerTool('bmad.switch_nfr_version', { description: 'Switch NFR assessment to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'nfr' })));

  mcp.registerTool('bmad.test_design_new', { description: 'Create a new Test Design version', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'test_design' })));
  mcp.registerTool('bmad.get_test_design_versions', { description: 'List Test Design versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'test_design' })));
  mcp.registerTool('bmad.switch_test_design_version', { description: 'Switch Test Design to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'test_design' })));

  mcp.registerTool('bmad.atdd_new', { description: 'Create a new ATDD checklist/version', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'atdd' })));
  mcp.registerTool('bmad.get_atdd_versions', { description: 'List ATDD versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'atdd' })));
  mcp.registerTool('bmad.switch_atdd_version', { description: 'Switch ATDD to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'atdd' })));

  mcp.registerTool('bmad.trace_new', { description: 'Create a new traceability matrix version', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'traceability' })));
  mcp.registerTool('bmad.get_trace_versions', { description: 'List traceability versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'traceability' })));
  mcp.registerTool('bmad.switch_trace_version', { description: 'Switch traceability to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'traceability' })));

  mcp.registerTool('bmad.ci_plan_new', { description: 'Create a new CI plan version', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'ci_plan' })));
  mcp.registerTool('bmad.get_ci_plan_versions', { description: 'List CI plan versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'ci_plan' })));
  mcp.registerTool('bmad.switch_ci_plan_version', { description: 'Switch CI plan to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'ci_plan' })));

  mcp.registerTool('bmad.tech_spec_new', { description: 'Create a new technical spec version', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'tech_spec' })));
  mcp.registerTool('bmad.get_tech_spec_versions', { description: 'List technical spec versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'tech_spec' })));
  mcp.registerTool('bmad.switch_tech_spec_version', { description: 'Switch technical spec to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'tech_spec' })));
  // Epics versioning
  mcp.registerTool('bmad.epic_new_version', { description: 'Create a new epic version', inputSchema: anyArgs }, withDb((db, input) => tools.epicNewVersion(db, input)));
  mcp.registerTool('bmad.get_epic_versions', { description: 'List epic versions', inputSchema: anyArgs }, withDb((db, input) => tools.getEpicVersions(db, input)));
  mcp.registerTool('bmad.switch_epic_version', { description: 'Switch epic to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchEpicVersion(db, input)));
  mcp.registerTool('bmad.add_epic_changelog', { description: 'Add changelog entry for epic', inputSchema: anyArgs }, withDb((db, input) => tools.addEpicChangelog(db, input)));
  mcp.registerTool('bmad.get_epic_changelog', { description: 'Get epic changelog', inputSchema: anyArgs }, withDb((db, input) => tools.getEpicChangelog(db, input)));
  // Review sessions
  mcp.registerTool('bmad.start_review', { description: 'Start a code review session', inputSchema: anyArgs }, withDb((db, input) => tools.startReview(db, input)));
  mcp.registerTool('bmad.add_review_finding', { description: 'Add a code review finding', inputSchema: anyArgs }, withDb((db, input) => tools.addReviewFinding(db, input)));
  mcp.registerTool('bmad.update_review_finding', { description: 'Update a finding status', inputSchema: anyArgs }, withDb((db, input) => tools.updateReviewFinding(db, input)));
  mcp.registerTool('bmad.close_review', { description: 'Close a review session', inputSchema: anyArgs }, withDb((db, input) => tools.closeReview(db, input)));
  mcp.registerTool('bmad.list_reviews', { description: 'List review sessions', inputSchema: anyArgs }, withDb((db, input) => tools.listReviews(db, input)));
  mcp.registerTool('bmad.review_approve', { description: 'Approve a review session', inputSchema: anyArgs }, withDb((db, input) => tools.reviewApprove(db, input)));
  mcp.registerTool('bmad.review_reject', { description: 'Reject a review session', inputSchema: anyArgs }, withDb((db, input) => tools.reviewReject(db, input)));
  // TEA / QA
  mcp.registerTool('bmad.create_test_plan', { description: 'Create a test plan', inputSchema: anyArgs }, withDb((db, input) => tools.createTestPlan(db, input)));
  mcp.registerTool('bmad.add_test_case', { description: 'Add a test case', inputSchema: anyArgs }, withDb((db, input) => tools.addTestCase(db, input)));
  mcp.registerTool('bmad.update_test_case', { description: 'Update a test case', inputSchema: anyArgs }, withDb((db, input) => tools.updateTestCase(db, input)));
  mcp.registerTool('bmad.record_test_run', { description: 'Record a test run', inputSchema: anyArgs }, withDb((db, input) => tools.recordTestRun(db, input)));
  mcp.registerTool('bmad.record_test_result', { description: 'Record a test result', inputSchema: anyArgs }, withDb((db, input) => tools.recordTestResult(db, input)));
  mcp.registerTool('bmad.get_test_coverage', { description: 'Get test coverage summary for a plan', inputSchema: anyArgs }, withDb((db, input) => tools.getTestCoverage(db, input)));
  // Planning docs other types
  mcp.registerTool('bmad.arch_new', { description: 'New architecture doc version', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'architecture' })));
  mcp.registerTool('bmad.get_arch_versions', { description: 'List architecture versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'architecture' })));
  mcp.registerTool('bmad.switch_arch_version', { description: 'Switch architecture to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'architecture' })));
  mcp.registerTool('bmad.ux_new', { description: 'New UX doc version', inputSchema: anyArgs }, withDb((db, input) => tools.docNewVersion(db, { ...input, type: 'ux' })));
  mcp.registerTool('bmad.get_ux_versions', { description: 'List UX versions', inputSchema: anyArgs }, withDb((db, input) => tools.getDocVersions(db, { ...input, type: 'ux' })));
  mcp.registerTool('bmad.switch_ux_version', { description: 'Switch UX to a version', inputSchema: anyArgs }, withDb((db, input) => tools.switchDocVersion(db, { ...input, type: 'ux' })));
  // Story versions
  mcp.registerTool('bmad.story_snapshot', { description: 'Snapshot a story (with tasks)', inputSchema: anyArgs }, withDb((db, input) => tools.storySnapshot(db, input)));
  mcp.registerTool('bmad.get_story_versions', { description: 'List story snapshots', inputSchema: anyArgs }, withDb((db, input) => tools.getStoryVersions(db, input)));
  mcp.registerTool('bmad.switch_story_version', { description: 'Switch story to a snapshot', inputSchema: anyArgs }, withDb((db, input) => tools.switchStoryVersion(db, input)));
  // Discovery / Brainstorm / Ideas
  mcp.registerTool('bmad.start_research_session', { description: 'Start a research/brainstorm session', inputSchema: anyArgs }, withDb((db, input) => tools.startResearchSession(db, input)));
  mcp.registerTool('bmad.add_research_note', { description: 'Add a research note', inputSchema: anyArgs }, withDb((db, input) => tools.addResearchNote(db, input)));
  mcp.registerTool('bmad.list_research_notes', { description: 'List research notes', inputSchema: anyArgs }, withDb((db, input) => tools.listResearchNotes(db, input)));
  mcp.registerTool('bmad.add_idea', { description: 'Add an idea to backlog', inputSchema: anyArgs }, withDb((db, input) => tools.addIdea(db, input)));
  mcp.registerTool('bmad.list_ideas', { description: 'List ideas backlog', inputSchema: anyArgs }, withDb((db, input) => tools.listIdeas(db, input)));
  // UX Validation
  mcp.registerTool('bmad.start_ux_review', { description: 'Start a UX review session', inputSchema: anyArgs }, withDb((db, input) => tools.startUxReview(db, input)));
  mcp.registerTool('bmad.approve_ux_review', { description: 'Approve UX review', inputSchema: anyArgs }, withDb((db, input) => tools.approveUxReview(db, input)));
  mcp.registerTool('bmad.reject_ux_review', { description: 'Reject UX review', inputSchema: anyArgs }, withDb((db, input) => tools.rejectUxReview(db, input)));
  mcp.registerTool('bmad.list_ux_reviews', { description: 'List UX reviews', inputSchema: anyArgs }, withDb((db, input) => tools.listUxReviews(db, input)));
  // Implementation readiness
  mcp.registerTool('bmad.start_readiness', { description: 'Start implementation readiness check', inputSchema: anyArgs }, withDb((db, input) => tools.startReadiness(db, input)));
  mcp.registerTool('bmad.update_readiness_item', { description: 'Update a readiness checklist item', inputSchema: anyArgs }, withDb((db, input) => tools.updateReadinessItem(db, input)));
  mcp.registerTool('bmad.get_readiness_status', { description: 'Get readiness status', inputSchema: anyArgs }, withDb((db, input) => tools.getReadinessStatus(db, input)));
  mcp.registerTool('bmad.finalize_readiness', { description: 'Finalize readiness and set status', inputSchema: anyArgs }, withDb((db, input) => tools.finalizeReadiness(db, input)));
  // Retrospective
  mcp.registerTool('bmad.retro_log', { description: 'Log a retrospective entry', inputSchema: anyArgs }, withDb((db, input) => tools.retroLog(db, input)));
  // Review fix
  mcp.registerTool('bmad.get_review_backlog', { description: 'List pending review follow-up items', inputSchema: anyArgs }, withDb((db, input) => tools.getReviewBacklog(db, input)));
  mcp.registerTool('bmad.complete_review_item', { description: 'Complete a review follow-up item', inputSchema: anyArgs }, withDb((db, input) => tools.completeReviewItem(db, input)));
  mcp.registerTool('bmad.bulk_complete_review', { description: 'Bulk-complete review items', inputSchema: anyArgs }, withDb((db, input) => tools.bulkCompleteReview(db, input)));
  // Reservations
  mcp.registerTool('bmad.reserve_task', { description: 'Reserve a task for an agent', inputSchema: anyArgs }, withDb((db, input) => tools.reserveTask(db, input)));
  mcp.registerTool('bmad.release_task', { description: 'Release a reserved task', inputSchema: anyArgs }, withDb((db, input) => tools.releaseTask(db, input)));
  mcp.registerTool('bmad.get_reservations', { description: 'List active reservations', inputSchema: anyArgs }, withDb((db, input) => tools.getReservations(db, input)));

  // Additional helpers
  mcp.registerTool('bmad.update_acceptance_criteria', { description: 'Update acceptance criteria for a story', inputSchema: anyArgs }, withDb((db, input) => tools.updateAcceptanceCriteria(db, input)));
  mcp.registerTool('bmad.list_stories', { description: 'List stories with filters', inputSchema: anyArgs }, withDb((db, input) => tools.listStories(db, input)));
  mcp.registerTool('bmad.list_epics', { description: 'List epics for a project', inputSchema: anyArgs }, withDb((db, input) => tools.listEpics(db, input)));
  mcp.registerTool('bmad.update_epic', { description: 'Create or update an epic', inputSchema: anyArgs }, withDb((db, input) => tools.updateEpic(db, input)));
  mcp.registerTool('bmad.search_stories', { description: 'Search stories by title/description', inputSchema: anyArgs }, withDb((db, input) => tools.searchStories(db, input)));
  // Components registry
  mcp.registerTool('bmad.register_component', { description: 'Register a reusable component', inputSchema: anyArgs }, withDb((db, input) => tools.registerComponent(db, input)));
  mcp.registerTool('bmad.list_components', { description: 'List registered components', inputSchema: anyArgs }, withDb((db, input) => tools.listComponents(db, input)));
  mcp.registerTool('bmad.export_component', { description: 'Export component files and docs', inputSchema: anyArgs }, withDb((db, input) => tools.exportComponent(db, input)));
  mcp.registerTool('bmad.commit_component', { description: 'Commit component to central repository', inputSchema: anyArgs }, withDb((db, input) => tools.commitComponent(db, input)));
  // Diagram stubs (Excalidraw helpers)
  mcp.registerTool('bmad.create_dataflow', { description: 'Create a dataflow diagram stub', inputSchema: anyArgs }, withDb((db, input) => tools.createDataflow(db, input)));
  mcp.registerTool('bmad.create_diagram', { description: 'Create a general diagram stub', inputSchema: anyArgs }, withDb((db, input) => tools.createDiagram(db, input)));
  mcp.registerTool('bmad.create_flowchart', { description: 'Create a flowchart stub', inputSchema: anyArgs }, withDb((db, input) => tools.createFlowchart(db, input)));
  mcp.registerTool('bmad.create_wireframe', { description: 'Create a wireframe stub', inputSchema: anyArgs }, withDb((db, input) => tools.createWireframe(db, input)));
  // Sprint planning generation
  mcp.registerTool('bmad.sprint_planning_generate', { description: 'Generate a basic sprint plan from backlog', inputSchema: anyArgs }, withDb((db, input) => tools.sprintPlanningGenerate(db, input)));

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  if (logLevel !== 'silent') {
    console.error('[bmad-mcp] ready (db:', dbPath + ', exportDir:', exportDir + ')');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
