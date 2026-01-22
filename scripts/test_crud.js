const path = require('path');
const fs = require('fs');
const { getDb, migrate } = require('../src/store/db');
const t = require('../src/tools');
const assert = require('assert');

(function main(){
  const dbPath = path.join(process.cwd(), 'test-crud.sqlite');
  try { fs.unlinkSync(dbPath); } catch {}
  const db = getDb(dbPath); migrate(db);
  const project_id = 'crud-' + Date.now();
  t.registerProject(db, { id: project_id, name: 'CRUD', root_path: process.cwd() });
  // Epic CRUD + versioning
  t.updateEpic(db, { project_id, number: 2, title: 'Epic2', description: 'E2' });
  t.epicNewVersion(db, { project_id, epic_number: 2, version: 'v1', title: 'E2 v1' });
  t.getEpicVersions(db, { project_id, epic_number: 2 });
  t.switchEpicVersion(db, { project_id, epic_number: 2, version: 'v1' });
  // Story CRUD
  t.createStory(db, { project_id, epic_number: 2, key: '2-1', title: 'S1', description: 'D', acceptance_criteria: ['A'], tasks: [{ description: 'T1', subtasks: ['S1'] }] });
  const story_id = `${project_id}:2-1`;
  t.updateStory(db, { story_id, title: 'S1b', status: 'in-progress' });
  t.setStoryLabels(db, { story_id, labels: ['bug', 'ui'] });
  assert(t.listStoryLabels(db, { story_id }).labels.length === 2, 'labels');
  t.storySnapshot(db, { story_id, version: 'snap1' });
  t.getStoryVersions(db, { story_id });
  t.switchStoryVersion(db, { story_id, version: 'snap1' });
  // Split & merge
  t.splitStory(db, { story_id, new_key: '2-9', title: 'Split', move_task_indices: [1] });
  t.mergeStories(db, { target_story_id: `${project_id}:2-1`, source_story_id: `${project_id}:2-9`, delete_source: true });
  // Bugs
  const bug = t.createBug(db, { project_id, title: 'Bug1', severity: 'high', description: 'Oops', story_id });
  t.linkBugFiles(db, { bug_id: bug.bug_id, files: ['a.js', 'b.js'] });
  t.generateBugfixPr(db, { bug_id: bug.bug_id });
  t.updateBugStatus(db, { bug_id: bug.bug_id, status: 'fixed' });
  t.listBugs(db, { project_id, status: 'fixed' });
  // Planning docs (arch/ux)
  t.docNewVersion(db, { project_id, type: 'architecture', version: '1.0', content: 'Arch v1' });
  t.getDocVersions(db, { project_id, type: 'architecture' });
  t.switchDocVersion(db, { project_id, type: 'architecture', version: '1.0' });
  t.docNewVersion(db, { project_id, type: 'ux', version: '1.0', content: 'UX v1' });
  // Reviews
  const rev = t.startReview(db, { project_id, story_id });
  t.addReviewFinding(db, { session_id: rev.session_id, severity: 'low', description: 'nit' });
  t.updateReviewFinding(db, { session_id: rev.session_id, idx: 1, status: 'closed' });
  t.closeReview(db, { session_id: rev.session_id, outcome: 'approved' });
  // TEA
  const plan = t.createTestPlan(db, { project_id, story_id, title: 'Plan', content: 'c' });
  t.addTestCase(db, { plan_id: plan.plan_id, key: 'C1', title: 'Case1' });
  t.recordTestRun(db, { plan_id: plan.plan_id, run_id: 'r1' });
  t.recordTestResult(db, { case_id: 1, run_id: 'r1', status: 'pass' });
  t.getTestCoverage(db, { plan_id: plan.plan_id });
  // Delete story safely (should fail with tasks unless forced)
  const del1 = t.deleteStory(db, { story_id, force: false });
  assert(del1.success === false || del1.error === 'incomplete-tasks');
  const del2 = t.deleteStory(db, { story_id, force: true });
  assert(del2.success, 'force delete');
  console.log('CRUD TEST OK');
})();

