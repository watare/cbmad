// Strong test for epics versioning, review sessions, TEA, and basic flows.
const path = require('path');
const os = require('os');
const assert = require('assert');
const { getDb, migrate } = require('../src/store/db');
const tools = require('../src/tools');

function cfgRoot() { return path.join(os.homedir(), '.config', 'bmad-server'); }

(async function main(){
  const dbPath = path.join(process.cwd(), 'test-full.sqlite');
  try { require('fs').unlinkSync(dbPath); } catch {}
  const db = getDb(dbPath); migrate(db);
  const project_id = 'testproj-' + Date.now();
  // Project
  tools.registerProject(db, { id: project_id, name: 'Test Project', root_path: process.cwd() });
  // Epic + versions
  tools.updateEpic(db, { project_id, number: 1, title: 'Epic 1', description: 'Base epic' });
  tools.epicNewVersion(db, { project_id, epic_number: 1, version: 'v1', title: 'Epic 1 v1', description: 'First', status: 'planned' });
  tools.epicNewVersion(db, { project_id, epic_number: 1, version: 'v2', title: 'Epic 1 v2', description: 'Second', status: 'in-progress' });
  const ev = tools.getEpicVersions(db, { project_id, epic_number: 1 });
  assert(ev.versions.length >= 2, 'Epic versions missing');
  tools.switchEpicVersion(db, { project_id, epic_number: 1, version: 'v1' });
  tools.addEpicChangelog(db, { project_id, epic_number: 1, entry: 'Adjusted scope' });
  const el = tools.getEpicChangelog(db, { project_id, epic_number: 1 });
  assert(el.entries.length >= 1, 'Epic changelog missing');

  // Story and review session
  tools.createStory(db, { project_id, epic_number: 1, key: '1-1', title: 'Story 1', description: 'impl', acceptance_criteria: ['AC1'], tasks: [{ description: 'Task A' }] });
  const story_id = `${project_id}:1-1`;
  const rev = tools.startReview(db, { project_id, story_id, reviewer: 'senior' });
  assert(rev.session_id, 'No review session');
  tools.addReviewFinding(db, { session_id: rev.session_id, severity: 'high', description: 'Refactor needed', file: 'src/a.js', line: 10 });
  tools.updateReviewFinding(db, { session_id: rev.session_id, idx: 1, status: 'fixed' });
  tools.closeReview(db, { session_id: rev.session_id, outcome: 'approved' });
  const revs = tools.listReviews(db, { project_id, story_id });
  assert(revs.reviews.length >= 1, 'No reviews listed');

  // TEA: test plan and cases
  const plan = tools.createTestPlan(db, { project_id, story_id, title: 'Plan 1', content: 'Initial plan' });
  assert(plan.plan_id, 'No plan id');
  tools.addTestCase(db, { plan_id: plan.plan_id, key: 'TC-1', title: 'case 1', steps: 'do x', expected: 'x ok' });
  tools.addTestCase(db, { plan_id: plan.plan_id, key: 'TC-2', title: 'case 2', steps: 'do y', expected: 'y ok' });
  tools.updateTestCase(db, { case_id: 1, status: 'pass' });
  tools.recordTestRun(db, { plan_id: plan.plan_id, run_id: 'run-1' });
  tools.recordTestResult(db, { case_id: 1, run_id: 'run-1', status: 'pass', notes: 'ok' });
  const cov = tools.getTestCoverage(db, { plan_id: plan.plan_id });
  assert(cov.total >= 2, 'Coverage wrong');

  console.log('TEST OK');
})();
