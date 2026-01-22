const path = require('path');
const fs = require('fs');
const { getDb, migrate } = require('../src/store/db');
const t = require('../src/tools');
const assert = require('assert');

(function main(){
  const dbPath = path.join(process.cwd(), 'test-discovery.sqlite');
  try { fs.unlinkSync(dbPath); } catch {}
  const db = getDb(dbPath); migrate(db);
  const project_id = 'disc-' + Date.now();
  t.registerProject(db, { id: project_id, name: 'Disc', root_path: process.cwd() });
  // Research + ideas
  const rs = t.startResearchSession(db, { project_id, topic: 'New market' });
  t.addResearchNote(db, { session_id: rs.session_id, type: 'brainstorm', content: 'Idea A', tags: ['p0'] });
  t.addResearchNote(db, { session_id: rs.session_id, type: 'research', content: 'Competitor X', tags: ['comp'] });
  const notes = t.listResearchNotes(db, { session_id: rs.session_id });
  assert(notes.notes.length === 2, 'notes');
  t.addIdea(db, { project_id, title: 'Feature Y', description: 'desc', score: 8 });
  const ideas = t.listIdeas(db, { project_id });
  assert(ideas.ideas.length >= 1, 'ideas');
  // Product brief as doc version
  t.docNewVersion(db, { project_id, type: 'product_brief', version: 'v1', content: 'Brief v1' });
  t.getDocVersions(db, { project_id, type: 'product_brief' });
  t.switchDocVersion(db, { project_id, type: 'product_brief', version: 'v1' });
  // UX review
  const ux = t.startUxReview(db, { project_id, version: 'v1', reviewer: 'ux-lead' });
  t.approveUxReview(db, { review_id: ux.review_id, notes: 'Looks good' });
  const uxList = t.listUxReviews(db, { project_id });
  assert(uxList.reviews.length >= 1, 'ux');
  // Readiness
  t.updateEpic(db, { project_id, number: 1, title: 'Epic' });
  t.createStory(db, { project_id, epic_number: 1, key: '1-1', title: 'Story', acceptance_criteria: ['ok'], tasks: [{ description: 'T' }] });
  const story_id = `${project_id}:1-1`;
  const rd = t.startReadiness(db, { project_id, story_id });
  t.updateReadinessItem(db, { readiness_id: rd.readiness_id, key: 'tests', met: true });
  t.updateReadinessItem(db, { readiness_id: rd.readiness_id, key: 'docs', met: true });
  const st = t.getReadinessStatus(db, { readiness_id: rd.readiness_id });
  assert(st.progress.met >= 2, 'readiness');
  t.finalizeReadiness(db, { readiness_id: rd.readiness_id });
  console.log('DISCOVERY TEST OK');
})();

