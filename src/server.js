/*
  BMAD MCP Server (Node.js, CommonJS)
  - SQLite backend (better-sqlite3)
  - Minimal set of MCP tools implemented per spec
*/
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/sdk/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio');

const { getDb, migrate } = require('./store/db');
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

  const db = getDb(dbPath);
  migrate(db);

  const server = new Server({
    name: 'bmad-mcp-server',
    version: '0.1.0',
  });

  // Register tools
  const register = (name, handler, inputSchema, description) => {
    server.tool(name, handler, { inputSchema, description });
  };

  // Project Management
  register('bmad.register_project', (input) => tools.registerProject(db, input), {
    type: 'object',
    required: ['id', 'name', 'root_path'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      root_path: { type: 'string' },
      config: { type: 'object', additionalProperties: true }
    }
  }, 'Register or update a BMAD project');

  register('bmad.get_project_context', (input) => tools.getProjectContext(db, input), {
    type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } }
  }, 'Get project summary context');

  // Story Management
  register('bmad.get_next_story', (input) => tools.getNextStory(db, input), {
    type: 'object', required: ['project_id'], properties: {
      project_id: { type: 'string' },
      status_filter: { enum: ['ready-for-dev', 'in-progress'] }
    }
  }, 'Get the next story to develop');

  register('bmad.get_story_context', (input) => tools.getStoryContext(db, input), {
    type: 'object', required: ['story_id'], properties: {
      story_id: { type: 'string' },
      include: {
        type: 'array', items: { enum: ['tasks', 'acceptance_criteria', 'dev_notes', 'files', 'changelog'] }
      }
    }
  }, 'Get full story context');

  register('bmad.get_story_summary', (input) => tools.getStorySummary(db, input), {
    type: 'object', required: ['story_id'], properties: { story_id: { type: 'string' } }
  }, 'Get condensed story summary');

  register('bmad.create_story', (input) => tools.createStory(db, input), {
    type: 'object',
    required: ['project_id', 'epic_number', 'key', 'title', 'acceptance_criteria', 'tasks'],
    properties: {
      project_id: { type: 'string' },
      epic_number: { type: 'number' },
      key: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      acceptance_criteria: { type: 'array', items: { type: 'string' } },
      tasks: { type: 'array', items: {
        type: 'object', required: ['description'], properties: {
          description: { type: 'string' },
          subtasks: { type: 'array', items: { type: 'string' } }
        }
      }},
      dev_notes: { type: 'string' }
    }
  }, 'Create a new story');

  register('bmad.update_story_status', (input) => tools.updateStoryStatus(db, input), {
    type: 'object', required: ['story_id', 'status'], properties: {
      story_id: { type: 'string' },
      status: { enum: ['draft', 'ready-for-dev', 'in-progress', 'review', 'done', 'blocked'] },
      reason: { type: 'string' }
    }
  }, 'Update story status');

  // Task Management
  register('bmad.complete_task', (input) => tools.completeTask(db, input), {
    type: 'object', required: ['story_id', 'task_idx'], properties: {
      story_id: { type: 'string' },
      task_idx: { type: 'number' },
      subtask_idx: { type: 'number' },
      completion_note: { type: 'string' }
    }
  }, 'Mark a task or subtask as completed');

  register('bmad.add_review_tasks', (input) => tools.addReviewTasks(db, input), {
    type: 'object', required: ['story_id', 'tasks'], properties: {
      story_id: { type: 'string' },
      tasks: { type: 'array', items: {
        type: 'object', required: ['description', 'severity'], properties: {
          description: { type: 'string' },
          severity: { enum: ['high', 'medium', 'low'] },
          related_file: { type: 'string' }
        }
      }}
    }
  }, 'Add review follow-up tasks');

  // Dev Notes & Files
  register('bmad.add_dev_note', (input) => tools.addDevNote(db, input), {
    type: 'object', required: ['story_id', 'note'], properties: {
      story_id: { type: 'string' },
      note: { type: 'string' },
      section: { enum: ['implementation', 'decisions', 'issues', 'general'] }
    }
  }, 'Append development note');

  register('bmad.register_files', (input) => tools.registerFiles(db, input), {
    type: 'object', required: ['story_id', 'files'], properties: {
      story_id: { type: 'string' },
      files: { type: 'array', items: {
        type: 'object', required: ['path', 'change_type'], properties: {
          path: { type: 'string' },
          change_type: { enum: ['added', 'modified', 'deleted'] }
        }
      }}
    }
  }, 'Register changed files under a story');

  register('bmad.add_changelog_entry', (input) => tools.addChangelogEntry(db, input), {
    type: 'object', required: ['story_id', 'entry'], properties: {
      story_id: { type: 'string' },
      entry: { type: 'string' }
    }
  }, 'Append a changelog entry');

  // Planning Documents
  register('bmad.get_planning_doc', (input) => tools.getPlanningDoc(db, input), {
    type: 'object', required: ['project_id', 'type', 'format'], properties: {
      project_id: { type: 'string' },
      type: { enum: ['prd', 'architecture', 'epics', 'ux'] },
      format: { enum: ['summary', 'full'] }
    }
  }, 'Fetch planning doc');

  register('bmad.update_planning_doc', (input) => tools.updatePlanningDoc(db, input), {
    type: 'object', required: ['project_id', 'type', 'content'], properties: {
      project_id: { type: 'string' },
      type: { enum: ['prd', 'architecture', 'epics', 'ux'] },
      content: { type: 'string' },
      generate_summary: { type: 'boolean' }
    }
  }, 'Update planning doc');

  // Sprint & Workflow
  register('bmad.get_sprint_status', (input) => tools.getSprintStatus(db, input), {
    type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } }
  }, 'Get sprint status');

  register('bmad.log_action', (input) => tools.logAction(db, input), {
    type: 'object', required: ['project_id', 'type', 'content'], properties: {
      project_id: { type: 'string' },
      story_id: { type: 'string' },
      type: { enum: ['dev', 'review', 'fix', 'create', 'pr'] },
      content: { type: 'string' }
    }
  }, 'Log orchestration action');

  // Export
  register('bmad.export_story_md', (input) => tools.exportStoryMd(db, input, { exportDir }), {
    type: 'object', required: ['story_id'], properties: {
      story_id: { type: 'string' },
      output_path: { type: 'string' }
    }
  }, 'Export a story to Markdown');

  register('bmad.export_project_md', (input) => tools.exportProjectMd(db, input, { exportDir }), {
    type: 'object', required: ['project_id'], properties: {
      project_id: { type: 'string' },
      output_dir: { type: 'string' }
    }
  }, 'Export the project to Markdown files');

  // Import
  register('bmad.import_project', (input) => tools.importProject(db, input), {
    type: 'object', required: ['project_id', 'root_path'], properties: {
      project_id: { type: 'string' },
      root_path: { type: 'string' },
      bmad_output_path: { type: 'string' }
    }
  }, 'Import a legacy BMAD project from files');

  // Schema Discovery
  register('bmad.get_mcp_schema', (input) => {
    return SCHEMA.asBundle();
  }, { type: 'object', properties: {} }, 'Return MCP tool schemas (inputs/outputs)');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (logLevel !== 'silent') {
    console.error('[bmad-mcp] ready (db:', dbPath + ', exportDir:', exportDir + ')');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
