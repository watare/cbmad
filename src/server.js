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

  // Import
  mcp.registerTool('bmad.import_project', { description: 'Import a legacy BMAD project from files', inputSchema: anyArgs }, withDb((db, input) => tools.importProject(db, input)));

  // Schema Discovery (no DB)
  mcp.registerTool('bmad.get_mcp_schema', { description: 'Return MCP tool schemas (inputs/outputs)', inputSchema: anyArgs }, async () => wrap(SCHEMA.asBundle()));

  // Additional helpers
  mcp.registerTool('bmad.update_acceptance_criteria', { description: 'Update acceptance criteria for a story', inputSchema: anyArgs }, withDb((db, input) => tools.updateAcceptanceCriteria(db, input)));
  mcp.registerTool('bmad.list_stories', { description: 'List stories with filters', inputSchema: anyArgs }, withDb((db, input) => tools.listStories(db, input)));
  mcp.registerTool('bmad.list_epics', { description: 'List epics for a project', inputSchema: anyArgs }, withDb((db, input) => tools.listEpics(db, input)));
  mcp.registerTool('bmad.update_epic', { description: 'Create or update an epic', inputSchema: anyArgs }, withDb((db, input) => tools.updateEpic(db, input)));
  mcp.registerTool('bmad.search_stories', { description: 'Search stories by title/description', inputSchema: anyArgs }, withDb((db, input) => tools.searchStories(db, input)));

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
