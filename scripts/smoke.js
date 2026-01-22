// Smoke test: runs without MCP transport to validate core DB flows
const path = require('path');
const os = require('os');
const { getDb, migrate } = require('../src/store/db');
const tools = require('../src/tools');

function cfgRoot() { return path.join(os.homedir(), '.config', 'bmad-server'); }

(function main(){
  const dbPath = path.join(cfgRoot(), 'db', 'bmad.sqlite');
  const db = getDb(dbPath); migrate(db);
  const project_id = 'smokeproj';
  const root_path = process.cwd();
  tools.registerProject(db, { id: project_id, name: 'Smoke Project', root_path, config: { user_name: 'tester' } });
  tools.updatePlanningDoc(db, { project_id, type: 'prd', content: 'SMOKE PRD', generate_summary: true });
  tools.createStory(db, { project_id, epic_number: 1, key: '1-1', title: 'Smoke story', description: 'test', acceptance_criteria: ['ok'], tasks: [{ description: 'do x', subtasks: ['a', 'b'] }] });
  const next = tools.getNextStory(db, { project_id });
  if (!next.found) throw new Error('No story found in smoke');
  const sid = `${project_id}:1-1`;
  tools.updateStoryStatus(db, { story_id: sid, status: 'in-progress' });
  tools.addDevNote(db, { story_id: sid, note: 'working', section: 'implementation' });
  tools.completeTask(db, { story_id: sid, task_idx: 1, completion_note: 'done' });
  // Export story and full project to project-local _bmad-output
  tools.exportStoryMd(db, { story_id: sid }, { exportDir: path.join(cfgRoot(), 'exports') });
  tools.exportProjectMd(db, { project_id }, { exportDir: path.join(cfgRoot(), 'exports') });
  const storyPath = path.join(root_path, '_bmad-output', 'stories', '1-1.md');
  console.log('Smoke test OK, story export exists:', require('fs').existsSync(storyPath));
})();
