const fs = require('fs');
const path = require('path');

function nowIso() { return new Date().toISOString(); }

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// ---------- Project Management ----------
function registerProject(db, input) {
  const { id, name, root_path, config } = input;
  const upsert = db.prepare(`INSERT INTO projects (id, name, root_path, config, created_at, updated_at)
    VALUES (@id, @name, @root_path, json(@config), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, root_path=excluded.root_path, config=excluded.config, updated_at=CURRENT_TIMESTAMP`);
  upsert.run({ id, name, root_path, config: config ? JSON.stringify(config) : null });
  return { success: true, project_id: id };
}

function getProjectContext(db, input) {
  const { project_id } = input;
  const project = db.prepare('SELECT id, name, config FROM projects WHERE id=?').get(project_id);
  if (!project) throw new Error('Project not found');
  const stats = db.prepare(`SELECT 
      (SELECT COUNT(*) FROM epics WHERE project_id = ?) AS total_epics,
      (SELECT COUNT(*) FROM stories WHERE project_id = ?) AS total_stories
    `).get(project_id, project_id);
  const byStatusStmt = db.prepare('SELECT status, COUNT(*) AS n FROM stories WHERE project_id=? GROUP BY status');
  const byStatus = Object.fromEntries(byStatusStmt.all(project_id).map(r => [r.status, r.n]));
  const sprint = db.prepare('SELECT current_sprint FROM sprint_status WHERE project_id=?').get(project_id);
  const recent = db.prepare('SELECT type, story_id, created_at FROM logs WHERE project_id=? ORDER BY id DESC LIMIT 10').all(project_id)
    .map(l => ({ type: l.type, story_key: l.story_id || null, timestamp: l.created_at }));
  return {
    project: { id: project.id, name: project.name, config: project.config ? JSON.parse(project.config) : null },
    stats: { total_epics: stats.total_epics, total_stories: stats.total_stories, stories_by_status: byStatus, current_sprint: sprint ? sprint.current_sprint : null },
    recent_activity: recent
  };
}

// ---------- Story Management ----------
function getNextStory(db, input) {
  const { project_id, status_filter = 'ready-for-dev' } = input;
  const row = db.prepare(`SELECT s.id, s.key, s.title, s.status,
      e.number AS epic_number, e.title AS epic_title,
      (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id AND t.done = 0 AND t.parent_task_id IS NULL) AS pending
    FROM stories s
    LEFT JOIN epics e ON s.epic_id = e.id
    WHERE s.project_id = ? AND s.status = ?
    ORDER BY s.updated_at ASC LIMIT 1`).get(project_id, status_filter);
  if (!row) return { found: false };
  return {
    found: true,
    story: {
      id: row.id,
      key: row.key,
      title: row.title,
      status: row.status,
      epic: { number: row.epic_number, title: row.epic_title },
      pending_tasks_count: row.pending
    }
  };
}

function getStoryContext(db, input) {
  const { story_id, include } = input;
  const story = db.prepare(`SELECT s.id, s.key, s.title, s.description, s.status,
      e.number AS epic_number, e.title AS epic_title
    FROM stories s LEFT JOIN epics e ON s.epic_id = e.id WHERE s.id = ?`).get(story_id);
  if (!story) throw new Error('Story not found');
  const want = (x) => !include || include.includes(x);
  const acceptance = want('acceptance_criteria') ? (db.prepare('SELECT acceptance_criteria FROM stories WHERE id=?').get(story_id).acceptance_criteria || '[]') : '[]';
  const acceptance_criteria = JSON.parse(acceptance);
  let tasks = [];
  if (want('tasks')) {
    const rows = db.prepare('SELECT * FROM tasks WHERE story_id=? ORDER BY parent_task_id NULLS FIRST, idx ASC, id ASC').all(story_id);
    const roots = rows.filter(r => !r.parent_task_id).map(r => ({ idx: r.idx, description: r.description, done: !!r.done, is_review_followup: !!r.is_review_followup, severity: r.severity }));
    const subs = rows.filter(r => r.parent_task_id);
    // Attach subtasks by idx order
    tasks = roots.map(rt => ({ ...rt, subtasks: subs.filter(s => s.parent_task_id && s.idx && s.description && s.done !== undefined && s.severity !== undefined ? s.parent_task_id : s.parent_task_id) && subs.filter(s => s.parent_task_id == rt.id).map(s => ({ idx: s.idx, description: s.description, done: !!s.done })) }));
    // Simpler: just return flat roots (subtasks filled below properly)
    const byParent = subs.reduce((acc, s) => { (acc[s.parent_task_id] ||= []).push(s); return acc; }, {});
    tasks = db.prepare('SELECT id, idx, description, done, is_review_followup, severity FROM tasks WHERE story_id=? AND parent_task_id IS NULL ORDER BY idx ASC').all(story_id)
      .map(r => ({ idx: r.idx, description: r.description, done: !!r.done, is_review_followup: !!r.is_review_followup, severity: r.severity, subtasks: (byParent[r.id] || []).sort((a,b)=>a.idx-b.idx).map(s => ({ idx: s.idx, description: s.description, done: !!s.done })) }));
  }
  const dev_notes = want('dev_notes') ? (db.prepare('SELECT dev_notes FROM stories WHERE id=?').get(story_id).dev_notes || '') : '';
  const files_changed = want('files') ? db.prepare('SELECT file_path AS path, change_type FROM story_files WHERE story_id=? ORDER BY id ASC').all(story_id) : [];
  const changelog = want('changelog') ? db.prepare('SELECT entry, created_at AS timestamp FROM changelog WHERE story_id=? ORDER BY id ASC').all(story_id) : [];
  const review = null; // placeholder for future review aggregation
  return {
    story: { id: story.id, key: story.key, title: story.title, description: story.description, status: story.status, epic: { number: story.epic_number, title: story.epic_title } },
    acceptance_criteria,
    tasks,
    dev_notes,
    files_changed,
    changelog,
    review
  };
}

function getStorySummary(db, input) {
  const { story_id } = input;
  const s = db.prepare('SELECT id, key, title, status FROM stories WHERE id=?').get(story_id);
  if (!s) throw new Error('Story not found');
  const rows = db.prepare('SELECT idx, description, done, parent_task_id FROM tasks WHERE story_id=? ORDER BY parent_task_id NULLS FIRST, idx ASC').all(story_id);
  const roots = rows.filter(r => !r.parent_task_id);
  const done = roots.filter(r => r.done).length;
  const total = roots.length;
  const current = roots.find(r => !r.done) || null;
  return {
    key: s.key,
    title: s.title,
    status: s.status,
    current_task: current ? { idx: current.idx, description: current.description } : null,
    progress: { done, total },
    blockers: []
  };
}

function createStory(db, input) {
  const { project_id, epic_number, key, title, description, acceptance_criteria, tasks, dev_notes } = input;
  let epic = db.prepare('SELECT id FROM epics WHERE project_id=? AND number=?').get(project_id, epic_number);
  if (!epic) {
    const epicId = `${project_id}:epic-${epic_number}`;
    db.prepare('INSERT INTO epics (id, project_id, number, title, status) VALUES (?,?,?,?,?)')
      .run(epicId, project_id, epic_number, `Epic ${epic_number}`, 'planned');
    epic = { id: epicId };
  }
  const storyId = `${project_id}:${key}`;
  db.prepare(`INSERT INTO stories (id, project_id, epic_id, key, title, description, acceptance_criteria, dev_notes, status)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(storyId, project_id, epic.id, key, title, description || null, JSON.stringify(acceptance_criteria || []), dev_notes || null, 'draft');
  let idx = 1;
  const insTask = db.prepare('INSERT INTO tasks (story_id, idx, description, done, is_review_followup) VALUES (?,?,?,?,0)');
  const insSub = db.prepare('INSERT INTO tasks (story_id, parent_task_id, idx, description, done) VALUES (?,?,?,?,0)');
  for (const t of tasks || []) {
    const res = insTask.run(storyId, idx++, t.description, 0);
    const parentId = res.lastInsertRowid;
    for (const [i, st] of (t.subtasks || []).entries()) {
      insSub.run(storyId, parentId, i + 1, st);
    }
  }
  return { success: true, story_id: storyId };
}

function updateStoryStatus(db, input) {
  const { story_id, status } = input;
  const prev = db.prepare('SELECT status FROM stories WHERE id=?').get(story_id);
  if (!prev) throw new Error('Story not found');
  db.prepare('UPDATE stories SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, story_id);
  return { success: true, previous_status: prev.status };
}

// ---------- Task Management ----------
function completeTask(db, input) {
  const { story_id, task_idx, subtask_idx, completion_note } = input;
  if (subtask_idx) {
    const parent = db.prepare('SELECT id FROM tasks WHERE story_id=? AND parent_task_id IS NULL AND idx=?').get(story_id, task_idx);
    if (!parent) throw new Error('Task not found');
    db.prepare('UPDATE tasks SET done=1, completed_at=CURRENT_TIMESTAMP WHERE story_id=? AND parent_task_id=? AND idx=?').run(story_id, parent.id, subtask_idx);
  } else {
    db.prepare('UPDATE tasks SET done=1, completed_at=CURRENT_TIMESTAMP WHERE story_id=? AND parent_task_id IS NULL AND idx=?').run(story_id, task_idx);
  }
  if (completion_note) db.prepare('INSERT INTO changelog (story_id, entry) VALUES (?,?)').run(story_id, completion_note);
  const rows = db.prepare('SELECT parent_task_id, done FROM tasks WHERE story_id=?').all(story_id);
  const roots = rows.filter(r => !r.parent_task_id);
  const done = roots.filter(r => r.done).length;
  const total = roots.length;
  const next = db.prepare('SELECT idx, description FROM tasks WHERE story_id=? AND parent_task_id IS NULL AND done=0 ORDER BY idx ASC LIMIT 1').get(story_id);
  return {
    success: true,
    story_progress: { done, total },
    next_task: next || null,
    all_tasks_done: done === total
  };
}

function addReviewTasks(db, input) {
  const { story_id, tasks } = input;
  const maxIdx = db.prepare('SELECT COALESCE(MAX(idx), 0) AS m FROM tasks WHERE story_id=? AND parent_task_id IS NULL').get(story_id).m;
  const ins = db.prepare('INSERT INTO tasks (story_id, idx, description, done, is_review_followup, severity) VALUES (?,?,?,?,1,?)');
  let i = maxIdx + 1;
  for (const t of tasks) {
    ins.run(story_id, i++, t.description, 0, t.severity);
  }
  return { success: true, tasks_added: tasks.length };
}

// ---------- Dev Notes & Files ----------
function addDevNote(db, input) {
  const { story_id, note, section } = input;
  const cur = db.prepare('SELECT dev_notes FROM stories WHERE id=?').get(story_id);
  if (!cur) throw new Error('Story not found');
  const header = section ? `\n\n### ${section}\n` : '\n\n';
  const newNotes = (cur.dev_notes || '') + header + note + '\n';
  db.prepare('UPDATE stories SET dev_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newNotes, story_id);
  return { success: true };
}

function registerFiles(db, input) {
  const { story_id, files } = input;
  const ins = db.prepare('INSERT INTO story_files (story_id, file_path, change_type) VALUES (?,?,?)');
  const tx = db.transaction((items) => { for (const f of items) ins.run(story_id, f.path, f.change_type); });
  tx(files || []);
  return { success: true, total_files: (files || []).length };
}

function addChangelogEntry(db, input) {
  const { story_id, entry } = input;
  db.prepare('INSERT INTO changelog (story_id, entry) VALUES (?,?)').run(story_id, entry);
  return { success: true };
}

// ---------- Planning Docs ----------
function getPlanningDoc(db, input) {
  const { project_id, type, format } = input;
  const row = db.prepare('SELECT content, summary, updated_at FROM planning_docs WHERE project_id=? AND type=?').get(project_id, type);
  if (!row) return { type, content: '', last_updated: nowIso() };
  return { type, content: format === 'summary' ? (row.summary || '') : (row.content || ''), last_updated: row.updated_at };
}

function updatePlanningDoc(db, input) {
  const { project_id, type, content, generate_summary } = input;
  const id = `${project_id}:${type}`;
  const summary = generate_summary ? (content.slice(0, 800) + (content.length > 800 ? '...': '')) : null;
  db.prepare(`INSERT INTO planning_docs (id, project_id, type, content, summary)
              VALUES (?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET content=excluded.content, summary=COALESCE(excluded.summary, planning_docs.summary), updated_at=CURRENT_TIMESTAMP`)
    .run(id, project_id, type, content, summary);
  return { success: true };
}

// ---------- Sprint & Workflow ----------
function getSprintStatus(db, input) {
  const { project_id } = input;
  const s = db.prepare('SELECT current_sprint, status_data FROM sprint_status WHERE project_id=?').get(project_id) || {};
  const epics = db.prepare('SELECT number, title, status FROM epics WHERE project_id=? ORDER BY number ASC').all(project_id).map(e => {
    const stories = db.prepare('SELECT key, title, status FROM stories WHERE epic_id=(SELECT id FROM epics WHERE project_id=? AND number=?) ORDER BY key ASC').all(project_id, e.number);
    return { number: e.number, title: e.title, status: e.status, stories };
  });
  const total_stories = db.prepare('SELECT COUNT(*) AS n FROM stories WHERE project_id=?').get(project_id).n;
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM stories WHERE project_id=? GROUP BY status').all(project_id).map(r => [r.status, r.n]));
  return {
    current_sprint: s.current_sprint || null,
    epics,
    summary: { total_stories, by_status: byStatus }
  };
}

function logAction(db, input) {
  const { project_id, story_id, type, content } = input;
  const res = db.prepare('INSERT INTO logs (project_id, story_id, type, content) VALUES (?,?,?,?)').run(project_id, story_id || null, type, content);
  return { success: true, log_id: res.lastInsertRowid };
}

// ---------- Export ----------
function renderStoryMarkdown(db, storyId) {
  const ctx = getStoryContext(db, { story_id: storyId });
  const { story, acceptance_criteria, tasks, dev_notes, files_changed, changelog } = ctx;
  const lines = [];
  lines.push(`# ${story.key} — ${story.title}`);
  lines.push('');
  lines.push(`Status: ${story.status}`);
  lines.push(`Epic: ${story.epic.number} — ${story.epic.title}`);
  if (story.description) { lines.push('', story.description); }
  lines.push('', '## Acceptance Criteria');
  for (const ac of acceptance_criteria) {
    const met = ac.met ? '[x]' : '[ ]';
    lines.push(`- ${met} ${ac.criterion || ac}`);
  }
  lines.push('', '## Tasks');
  for (const t of tasks) {
    lines.push(`- [${t.done ? 'x':' '}] (${t.idx}) ${t.description}`);
    for (const st of (t.subtasks || [])) {
      lines.push(`  - [${st.done ? 'x':' '}] (${st.idx}) ${st.description}`);
    }
  }
  if (dev_notes) { lines.push('', '## Dev Notes', dev_notes); }
  if (files_changed.length) {
    lines.push('', '## Files Changed');
    for (const f of files_changed) lines.push(`- ${f.change_type}: ${f.path}`);
  }
  if (changelog.length) {
    lines.push('', '## Changelog');
    for (const c of changelog) lines.push(`- ${c.timestamp}: ${c.entry}`);
  }
  return lines.join('\n');
}

function exportStoryMd(db, input, { exportDir }) {
  const { story_id, output_path } = input;
  const s = db.prepare('SELECT key, project_id FROM stories WHERE id=?').get(story_id);
  if (!s) throw new Error('Story not found');
  const md = renderStoryMarkdown(db, story_id);
  // Default: project/_bmad-output/stories/{key}.md
  const proj = db.prepare('SELECT root_path FROM projects WHERE id=?').get(s.project_id);
  const projectRoot = proj ? proj.root_path : null;
  const defaultBase = projectRoot ? path.join(projectRoot, '_bmad-output') : path.join(exportDir, s.project_id);
  const defaultPath = path.join(defaultBase, 'stories', `${s.key}.md`);
  const out = output_path ? output_path : defaultPath;
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, md, 'utf8');
  return { success: true, path: out };
}

function exportProjectMd(db, input, { exportDir }) {
  const { project_id, output_dir } = input;
  // Default: project/_bmad-output/
  const proj = db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id);
  const defaultBase = proj && proj.root_path ? path.join(proj.root_path, '_bmad-output') : path.join(exportDir, project_id);
  const baseDir = output_dir || defaultBase;
  const stories = db.prepare('SELECT id FROM stories WHERE project_id=?').all(project_id);
  let exportedStories = 0;
  for (const s of stories) { exportStoryMd(db, { story_id: s.id }, { exportDir: baseDir }); exportedStories++; }
  const logs = db.prepare('SELECT type, content, created_at FROM logs WHERE project_id=? ORDER BY id ASC').all(project_id);
  if (logs.length) {
    const lines = ['# Logs'];
    for (const l of logs) lines.push(`- ${l.created_at} [${l.type}] ${l.content}`);
    ensureDir(path.join(baseDir, 'logs'));
    fs.writeFileSync(path.join(baseDir, 'logs', 'logs.md'), lines.join('\n'), 'utf8');
  }
  const planning = db.prepare('SELECT type, content FROM planning_docs WHERE project_id=?').all(project_id);
  if (planning.length) {
    ensureDir(path.join(baseDir, 'planning'));
    for (const p of planning) {
      fs.writeFileSync(path.join(baseDir, 'planning', `${p.type}.md`), p.content || '', 'utf8');
    }
  }
  return { success: true, exported: { stories: exportedStories, planning_docs: planning.length, logs: logs.length } };
}

// ---------- Import (stub: tolerant, minimal) ----------
function importProject(db, input) {
  const { project_id, root_path, bmad_output_path } = input;
  registerProject(db, { id: project_id, name: project_id, root_path });
  const outDir = bmad_output_path || path.join(root_path, '_bmad-output');
  let importedStories = 0;
  let importedEpics = 0;
  let importedPlanning = 0;
  const warnings = [];
  // Minimal: if we find planning-artifacts/epics.md, create epics placeholders
  const epicsMd = path.join(outDir, 'planning-artifacts', 'epics.md');
  if (fs.existsSync(epicsMd)) {
    const txt = fs.readFileSync(epicsMd, 'utf8');
    const lines = txt.split(/\r?\n/);
    for (const ln of lines) {
      const m = ln.match(/^\s*[-*]\s*Epic\s+(\d+)\s*[:\-]\s*(.+)$/i);
      if (m) {
        const num = parseInt(m[1], 10); const title = m[2].trim();
        const id = `${project_id}:epic-${num}`;
        db.prepare('INSERT OR IGNORE INTO epics (id, project_id, number, title, status) VALUES (?,?,?,?,?)').run(id, project_id, num, title, 'planned');
        importedEpics++;
      }
    }
  }
  // Import story markdowns from implementation-artifacts/*.md (very tolerant)
  const implDir = path.join(outDir, 'implementation-artifacts');
  if (fs.existsSync(implDir)) {
    for (const f of fs.readdirSync(implDir)) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(implDir, f), 'utf8');
      const keyMatch = content.match(/^#\s*(\d+-\d+)\b.*$/m);
      const titleMatch = content.match(/^#\s*\d+-\d+\s*[—-]\s*(.+)$/m);
      const key = keyMatch ? keyMatch[1] : path.basename(f, '.md');
      const title = titleMatch ? titleMatch[1].trim() : key;
      const storyId = `${project_id}:${key}`;
      db.prepare(`INSERT OR IGNORE INTO stories (id, project_id, key, title, status)
                  VALUES (?,?,?,?, 'draft')`).run(storyId, project_id, key, title);
      importedStories++;
    }
  }
  // Planning docs
  const planningDir = path.join(outDir, 'planning-artifacts');
  if (fs.existsSync(planningDir)) {
    for (const t of ['prd', 'architecture']) {
      const p = path.join(planningDir, `${t}.md`);
      if (fs.existsSync(p)) {
        updatePlanningDoc(db, { project_id, type: t, content: fs.readFileSync(p, 'utf8'), generate_summary: true });
        importedPlanning++;
      }
    }
  }
  return { success: true, imported: { epics: importedEpics, stories: importedStories, planning_docs: importedPlanning }, warnings };
}

// ---------- Review Fix Workflow ----------
function getReviewBacklog(db, input) {
  const { project_id, story_id, limit = 100 } = input;
  if (story_id) {
    const rows = db.prepare(`SELECT idx, description, severity FROM tasks WHERE story_id=? AND is_review_followup=1 AND done=0 ORDER BY idx ASC LIMIT ?`).all(story_id, limit);
    return { items: rows.map(r => ({ story_id, idx: r.idx, description: r.description, severity: r.severity || null })) };
  }
  const rows = db.prepare(`SELECT s.id as story_id, s.key, t.idx, t.description, t.severity
                           FROM tasks t JOIN stories s ON s.id=t.story_id
                           WHERE s.project_id=? AND t.is_review_followup=1 AND t.done=0
                           ORDER BY s.updated_at DESC, t.idx ASC LIMIT ?`).all(project_id, limit);
  return { items: rows.map(r => ({ story_id: r.story_id, story_key: r.key, idx: r.idx, description: r.description, severity: r.severity || null })) };
}

function completeReviewItem(db, input) {
  const { story_id, idx } = input;
  const res = db.prepare(`UPDATE tasks SET done=1, completed_at=CURRENT_TIMESTAMP WHERE story_id=? AND parent_task_id IS NULL AND idx=? AND is_review_followup=1`).run(story_id, idx);
  return { success: res.changes > 0 };
}

function bulkCompleteReview(db, input) {
  const { story_id, indices } = input;
  const tx = db.transaction(() => {
    let n = 0;
    for (const i of indices || []) {
      const r = db.prepare(`UPDATE tasks SET done=1, completed_at=CURRENT_TIMESTAMP WHERE story_id=? AND parent_task_id IS NULL AND idx=? AND is_review_followup=1`).run(story_id, i);
      n += r.changes ? 1 : 0;
    }
    return n;
  });
  const count = tx();
  return { success: true, completed: count };
}

// ---------- Reservations (Multi-agent safety) ----------
function reserveTask(db, input) {
  const { story_id, task_idx, agent, ttl_seconds = 1800 } = input;
  const project = db.prepare('SELECT project_id FROM stories WHERE id=?').get(story_id);
  if (!project) throw new Error('Story not found');
  const now = Date.now();
  const exp = new Date(now + ttl_seconds * 1000).toISOString();
  const existing = db.prepare('SELECT agent, expires_at FROM reservations WHERE story_id=? AND task_idx=?').get(story_id, task_idx);
  if (existing) {
    const expired = new Date(existing.expires_at).getTime() < now;
    if (!expired && existing.agent !== agent) {
      return { success: false, reserved_by: existing.agent, expires_at: existing.expires_at };
    }
    db.prepare('UPDATE reservations SET agent=?, expires_at=?, created_at=CURRENT_TIMESTAMP WHERE story_id=? AND task_idx=?')
      .run(agent, exp, story_id, task_idx);
    return { success: true, story_id, task_idx, agent, expires_at: exp };
  }
  db.prepare('INSERT INTO reservations (project_id, story_id, task_idx, agent, expires_at) VALUES (?,?,?,?,?)')
    .run(project.project_id, story_id, task_idx, agent, exp);
  return { success: true, story_id, task_idx, agent, expires_at: exp };
}

function releaseTask(db, input) {
  const { story_id, task_idx, agent } = input;
  const row = db.prepare('SELECT agent FROM reservations WHERE story_id=? AND task_idx=?').get(story_id, task_idx);
  if (!row) return { success: true };
  if (row.agent !== agent) return { success: false, error: 'not-owner' };
  db.prepare('DELETE FROM reservations WHERE story_id=? AND task_idx=?').run(story_id, task_idx);
  return { success: true };
}

function getReservations(db, input) {
  const { project_id, story_id } = input;
  const nowIso = new Date().toISOString();
  db.prepare('DELETE FROM reservations WHERE expires_at < ?').run(nowIso);
  let rows;
  if (story_id) rows = db.prepare('SELECT story_id, task_idx, agent, expires_at FROM reservations WHERE story_id=? ORDER BY created_at DESC').all(story_id);
  else rows = db.prepare('SELECT story_id, task_idx, agent, expires_at FROM reservations WHERE project_id=? ORDER BY created_at DESC').all(project_id);
  return { reservations: rows };
}

// ---------- PR Generation ----------
function generatePr(db, input) {
  const { story_id } = input;
  const ctx = getStoryContext(db, { story_id });
  const { story, acceptance_criteria, tasks, dev_notes, files_changed, changelog } = ctx;
  const title = `[${story.key}] ${story.title}`;
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('', story.description || '');
  lines.push('', '## Acceptance Criteria');
  for (const ac of acceptance_criteria) lines.push(`- ${ac.met ? '[x]' : '[ ]'} ${ac.criterion || ac}`);
  lines.push('', '## Implementation Summary');
  for (const t of tasks) lines.push(`- [${t.done ? 'x':' '}] (${t.idx}) ${t.description}`);
  if (files_changed?.length) {
    lines.push('', '## Changed Files');
    for (const f of files_changed) lines.push(`- ${f.change_type}: ${f.path}`);
  }
  if (changelog?.length) {
    lines.push('', '## Changelog');
    for (const c of changelog) lines.push(`- ${c.timestamp}: ${c.entry}`);
  }
  const body = lines.join('\n');
  return { title, body };
}

function exportPrMd(db, input, { exportDir }) {
  const { story_id, output_path } = input;
  const s = db.prepare('SELECT key, project_id FROM stories WHERE id=?').get(story_id);
  if (!s) throw new Error('Story not found');
  const pr = generatePr(db, { story_id });
  const proj = db.prepare('SELECT root_path FROM projects WHERE id=?').get(s.project_id);
  const projectRoot = proj ? proj.root_path : null;
  const base = projectRoot ? path.join(projectRoot, '_bmad-output') : path.join(exportDir, s.project_id);
  const defaultPath = path.join(base, 'planning', `PR-${s.key}.md`);
  const out = output_path || defaultPath;
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, `# ${pr.title}\n\n${pr.body}\n`, 'utf8');
  return { success: true, path: out };
}

module.exports = {
  registerProject,
  getProjectContext,
  getNextStory,
  getStoryContext,
  getStorySummary,
  createStory,
  updateStoryStatus,
  completeTask,
  addReviewTasks,
  addDevNote,
  registerFiles,
  addChangelogEntry,
  getPlanningDoc,
  updatePlanningDoc,
  getSprintStatus,
  logAction,
  exportStoryMd,
  exportProjectMd,
  importProject,
  // new
  getReviewBacklog,
  completeReviewItem,
  bulkCompleteReview,
  reserveTask,
  releaseTask,
  getReservations,
  generatePr,
  exportPrMd,
};

// --- Additional workflow helpers ---
function setCurrentSprint(db, input) {
  const { project_id, current_sprint } = input;
  db.prepare(`INSERT INTO sprint_status (project_id, current_sprint, status_data, updated_at)
              VALUES (?,?,NULL,CURRENT_TIMESTAMP)
              ON CONFLICT(project_id) DO UPDATE SET current_sprint=excluded.current_sprint, updated_at=CURRENT_TIMESTAMP`).run(project_id, current_sprint || null);
  return { success: true, current_sprint: current_sprint || null };
}

function updateAcceptanceCriteria(db, input) {
  const { story_id, acceptance_criteria } = input;
  const s = db.prepare('SELECT id FROM stories WHERE id=?').get(story_id);
  if (!s) throw new Error('Story not found');
  const ac = Array.isArray(acceptance_criteria) ? acceptance_criteria : [];
  db.prepare('UPDATE stories SET acceptance_criteria=json(?), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(ac), story_id);
  return { success: true };
}

function listStories(db, input) {
  const { project_id, status, epic_number, limit = 50, offset = 0 } = input;
  let sql = `SELECT s.key, s.title, s.status, e.number as epic_number
             FROM stories s LEFT JOIN epics e ON s.epic_id=e.id
             WHERE s.project_id=?`;
  const params = [project_id];
  if (status) { sql += ' AND s.status=?'; params.push(status); }
  if (epic_number != null) { sql += ' AND e.number=?'; params.push(epic_number); }
  sql += ' ORDER BY s.updated_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
  const rows = db.prepare(sql).all(...params);
  return { stories: rows };
}

function listEpics(db, input) {
  const { project_id } = input;
  const rows = db.prepare('SELECT number, title, status FROM epics WHERE project_id=? ORDER BY number ASC').all(project_id);
  return { epics: rows };
}

function updateEpic(db, input) {
  const { project_id, number, title, description, status } = input;
  const id = `${project_id}:epic-${number}`;
  db.prepare(`INSERT INTO epics (id, project_id, number, title, description, status)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET title=COALESCE(excluded.title, epics.title), description=COALESCE(excluded.description, epics.description), status=COALESCE(excluded.status, epics.status), updated_at=CURRENT_TIMESTAMP`)
    .run(id, project_id, number, title || null, description || null, status || null);
  return { success: true };
}

function searchStories(db, input) {
  const { project_id, query, limit = 50 } = input;
  const q = `%${query}%`;
  const rows = db.prepare(`SELECT key, title, status FROM stories WHERE project_id=? AND (title LIKE ? OR COALESCE(description,'') LIKE ?) ORDER BY updated_at DESC LIMIT ?`).all(project_id, q, q, limit);
  return { stories: rows };
}

module.exports.setCurrentSprint = setCurrentSprint;
module.exports.updateAcceptanceCriteria = updateAcceptanceCriteria;
module.exports.listStories = listStories;
module.exports.listEpics = listEpics;
module.exports.updateEpic = updateEpic;
module.exports.searchStories = searchStories;

// ---------- Story Admin ----------
function updateStory(db, input) {
  const { story_id, title, description, epic_number, status } = input;
  const s = db.prepare('SELECT project_id FROM stories WHERE id=?').get(story_id);
  if (!s) throw new Error('Story not found');
  let epicId = null;
  if (epic_number != null) {
    const e = db.prepare('SELECT id FROM epics WHERE project_id=? AND number=?').get(s.project_id, epic_number);
    if (!e) throw new Error('Epic not found');
    epicId = e.id;
  }
  const fields = [];
  const vals = [];
  if (title != null) { fields.push('title=?'); vals.push(title); }
  if (description != null) { fields.push('description=?'); vals.push(description); }
  if (epicId != null) { fields.push('epic_id=?'); vals.push(epicId); }
  if (status != null) { fields.push('status=?'); vals.push(status); }
  if (!fields.length) return { success: true };
  vals.push(story_id);
  db.prepare(`UPDATE stories SET ${fields.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...vals);
  return { success: true };
}

function deleteStory(db, input) {
  const { story_id, force = false } = input;
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE story_id=? AND done=0').get(story_id).n;
  if (cnt > 0 && !force) {
    return { success: false, error: 'incomplete-tasks' };
  }
  db.prepare('DELETE FROM stories WHERE id=?').run(story_id);
  return { success: true };
}

// ---------- Epic Admin ----------
function getEpic(db, input) {
  const { project_id, number } = input;
  const row = db.prepare('SELECT id, number, title, description, status FROM epics WHERE project_id=? AND number=?').get(project_id, number);
  if (!row) return { found: false };
  return { found: true, epic: row };
}

function deleteEpic(db, input) {
  const { project_id, number, force = false } = input;
  const epic = db.prepare('SELECT id FROM epics WHERE project_id=? AND number=?').get(project_id, number);
  if (!epic) return { success: true };
  const stories = db.prepare('SELECT COUNT(*) AS n FROM stories WHERE epic_id=?').get(epic.id).n;
  if (stories > 0 && !force) return { success: false, error: 'stories-exist' };
  if (stories > 0 && force) db.prepare('UPDATE stories SET epic_id=NULL WHERE epic_id=?').run(epic.id);
  db.prepare('DELETE FROM epics WHERE id=?').run(epic.id);
  return { success: true };
}

// ---------- Labels ----------
function setStoryLabels(db, input) {
  const { story_id, labels } = input;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM story_labels WHERE story_id=?').run(story_id);
    const ins = db.prepare('INSERT INTO story_labels (story_id, label) VALUES (?,?)');
    for (const l of (labels || [])) ins.run(story_id, l);
  });
  tx();
  return { success: true };
}

function listStoryLabels(db, input) {
  const { story_id } = input;
  const rows = db.prepare('SELECT label FROM story_labels WHERE story_id=? ORDER BY label ASC').all(story_id);
  return { labels: rows.map(r => r.label) };
}

function searchByLabel(db, input) {
  const { project_id, label } = input;
  const rows = db.prepare('SELECT s.key, s.title, s.status FROM stories s JOIN story_labels l ON l.story_id=s.id WHERE s.project_id=? AND l.label=? ORDER BY s.updated_at DESC').all(project_id, label);
  return { stories: rows };
}

// ---------- Split/Merge ----------
function splitStory(db, input) {
  const { story_id, new_key, title, move_task_indices = [] } = input;
  const s = db.prepare('SELECT project_id, epic_id FROM stories WHERE id=?').get(story_id);
  if (!s) throw new Error('Story not found');
  const newId = `${s.project_id}:${new_key}`;
  db.prepare('INSERT INTO stories (id, project_id, epic_id, key, title, status) VALUES (?,?,?,?,?,?)')
    .run(newId, s.project_id, s.epic_id, new_key, title || new_key, 'draft');
  const move = db.prepare('UPDATE tasks SET story_id=? WHERE story_id=? AND parent_task_id IS NULL AND idx=?');
  let moved = 0;
  for (const idx of move_task_indices) { const r = move.run(newId, story_id, idx); moved += r.changes ? 1 : 0; }
  return { success: true, new_story_id: newId, moved };
}

function mergeStories(db, input) {
  const { target_story_id, source_story_id, delete_source = true } = input;
  const baseIdx = db.prepare('SELECT COALESCE(MAX(idx),0) AS m FROM tasks WHERE story_id=? AND parent_task_id IS NULL').get(target_story_id).m;
  let i = baseIdx + 1;
  const rows = db.prepare('SELECT idx, description, done FROM tasks WHERE story_id=? AND parent_task_id IS NULL ORDER BY idx ASC').all(source_story_id);
  const ins = db.prepare('INSERT INTO tasks (story_id, idx, description, done) VALUES (?,?,?,?)');
  for (const r of rows) ins.run(target_story_id, i++, r.description, r.done ? 1 : 0);
  if (delete_source) db.prepare('DELETE FROM stories WHERE id=?').run(source_story_id);
  return { success: true };
}

// ---------- Story Sprint Assignment ----------
function setStorySprint(db, input) {
  const { story_id, sprint_label } = input;
  db.prepare(`INSERT INTO story_sprints (story_id, sprint_label, updated_at)
              VALUES (?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(story_id) DO UPDATE SET sprint_label=excluded.sprint_label, updated_at=CURRENT_TIMESTAMP`).run(story_id, sprint_label);
  return { success: true };
}

function listStoriesBySprint(db, input) {
  const { project_id, sprint_label } = input;
  const rows = db.prepare(`SELECT s.key, s.title, s.status
                           FROM stories s JOIN story_sprints ss ON ss.story_id=s.id
                           WHERE s.project_id=? AND ss.sprint_label=?
                           ORDER BY s.key ASC`).all(project_id, sprint_label);
  return { stories: rows };
}

// ---------- Document Discovery ----------
function summarize(text, max = 800) {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.slice(0, max) + (t.length > max ? '...' : '');
}

function detectDocType(filePath) {
  const p = filePath.toLowerCase();
  if (p.endsWith('readme.md')) return 'readme';
  if (p.includes('/adr') || p.includes('/decisions')) return 'adr';
  if (p.includes('/docs/')) return 'doc';
  if (p.includes('.github/workflows/') || p.endsWith('.yml') || p.endsWith('.yaml')) return 'ci';
  return 'doc';
}

function walkFiles(root, includeExt = ['.md', '.markdown', '.yml', '.yaml']) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    const ents = fs.readdirSync(d, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        stack.push(p);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (includeExt.includes(ext)) out.push(p);
      }
    }
  }
  return out;
}

function scanDocuments(db, input) {
  const { project_id, root_path, patterns } = input;
  const root = root_path || (db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id)?.root_path);
  if (!root) throw new Error('root_path not found');
  const files = walkFiles(root);
  let count = 0;
  const upsert = db.prepare(`INSERT INTO documents (project_id, path, type, tags, content, summary)
                             VALUES (?,?,?,?,?,?)
                             ON CONFLICT(project_id, path) DO UPDATE SET type=excluded.type, tags=excluded.tags, content=excluded.content, summary=excluded.summary, updated_at=CURRENT_TIMESTAMP`);
  for (const f of files) {
    const rel = path.relative(root, f);
    const txt = fs.readFileSync(f, 'utf8');
    const type = detectDocType(rel);
    const tags = type === 'ci' ? 'devops,ci' : (type === 'adr' ? 'adr' : 'docs');
    upsert.run(project_id, rel, type, tags, txt, summarize(txt));
    count++;
  }
  return { success: true, scanned: count };
}

function listDocuments(db, input) {
  const { project_id, type, limit = 100, offset = 0 } = input;
  let sql = 'SELECT id, path, type, tags, summary, updated_at FROM documents WHERE project_id=?';
  const params = [project_id];
  if (type) { sql += ' AND type=?'; params.push(type); }
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
  return { documents: db.prepare(sql).all(...params) };
}

function getDocument(db, input) {
  const { document_id, format = 'summary' } = input;
  const row = db.prepare('SELECT id, path, type, tags, content, summary, updated_at FROM documents WHERE id=?').get(document_id);
  if (!row) throw new Error('Document not found');
  return { id: row.id, path: row.path, type: row.type, tags: row.tags, content: format === 'full' ? row.content : row.summary, updated_at: row.updated_at };
}

function searchDocuments(db, input) {
  const { project_id, query, limit = 50 } = input;
  const q = `%${query}%`;
  const rows = db.prepare('SELECT id, path, type, tags, summary FROM documents WHERE project_id=? AND (path LIKE ? OR summary LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT ?').all(project_id, q, q, q, limit);
  return { documents: rows };
}

module.exports.updateStory = updateStory;
module.exports.deleteStory = deleteStory;
module.exports.getEpic = getEpic;
module.exports.deleteEpic = deleteEpic;
module.exports.setStoryLabels = setStoryLabels;
module.exports.listStoryLabels = listStoryLabels;
module.exports.searchByLabel = searchByLabel;
module.exports.splitStory = splitStory;
module.exports.mergeStories = mergeStories;
module.exports.setStorySprint = setStorySprint;
module.exports.listStoriesBySprint = listStoriesBySprint;
module.exports.scanDocuments = scanDocuments;
module.exports.listDocuments = listDocuments;
module.exports.getDocument = getDocument;
module.exports.searchDocuments = searchDocuments;

// ---------- Bugs / Quick Fix ----------
function nextBugId(db, project_id) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM bugs WHERE project_id=?").get(project_id);
  const n = (row?.n || 0) + 1;
  return `${project_id}:bug-${n}`;
}

function createBug(db, input) {
  const { project_id, title, description, severity, story_id, introduced_in } = input;
  const id = nextBugId(db, project_id);
  db.prepare(`INSERT INTO bugs (id, project_id, title, description, severity, status, story_id, introduced_in)
              VALUES (?,?,?,?,?,'open',?,?)`).run(id, project_id, title, description || null, severity || null, story_id || null, introduced_in || null);
  return { success: true, bug_id: id };
}

function updateBugStatus(db, input) {
  const { bug_id, status, fixed_in } = input;
  const res = db.prepare('UPDATE bugs SET status=?, fixed_in=COALESCE(?,fixed_in), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, fixed_in || null, bug_id);
  return { success: res.changes > 0 };
}

function getBug(db, input) {
  const { bug_id } = input;
  const b = db.prepare('SELECT * FROM bugs WHERE id=?').get(bug_id);
  if (!b) return { found: false };
  const files = db.prepare('SELECT file_path FROM bug_files WHERE bug_id=?').all(bug_id).map(r => r.file_path);
  return { found: true, bug: { ...b, files } };
}

function listBugs(db, input) {
  const { project_id, status, severity, limit = 100, offset = 0 } = input;
  let sql = 'SELECT id, title, severity, status, story_id, created_at, updated_at FROM bugs WHERE project_id=?';
  const params = [project_id];
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (severity) { sql += ' AND severity=?'; params.push(severity); }
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
  return { bugs: db.prepare(sql).all(...params) };
}

function linkBugFiles(db, input) {
  const { bug_id, files } = input;
  const ins = db.prepare('INSERT INTO bug_files (bug_id, file_path) VALUES (?,?)');
  const tx = db.transaction(() => {
    for (const f of files || []) ins.run(bug_id, f);
  });
  tx();
  return { success: true };
}

function linkBugStory(db, input) {
  const { bug_id, story_id } = input;
  db.prepare('UPDATE bugs SET story_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(story_id, bug_id);
  return { success: true };
}

function generateBugfixPr(db, input) {
  const { bug_id } = input;
  const { found, bug } = getBug(db, { bug_id });
  if (!found) throw new Error('Bug not found');
  const title = `[BUGFIX] ${bug.title}`;
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('', `Severity: ${bug.severity || 'n/a'}`);
  lines.push('', `Status: ${bug.status}`);
  if (bug.story_id) {
    const s = db.prepare('SELECT key, title FROM stories WHERE id=?').get(bug.story_id) || {};
    lines.push('', `Story: ${s.key || ''} ${s.title || ''}`);
  }
  if (bug.files?.length) {
    lines.push('', '## Impacted Files');
    for (const f of bug.files) lines.push(`- ${f}`);
  }
  lines.push('', '## Description');
  lines.push(bug.description || '');
  return { title, body: lines.join('\n') };
}

module.exports.createBug = createBug;
module.exports.updateBugStatus = updateBugStatus;
module.exports.getBug = getBug;
module.exports.listBugs = listBugs;
module.exports.linkBugFiles = linkBugFiles;
module.exports.linkBugStory = linkBugStory;
module.exports.generateBugfixPr = generateBugfixPr;

// ---------- PRD Versioning ----------
function prdNew(db, input) {
  const { project_id, version, content } = input;
  const summary = summarize(content, 1200);
  db.prepare('INSERT INTO planning_doc_versions (project_id, type, version, content, summary) VALUES (?,?,?,?,?)')
    .run(project_id, 'prd', version, content, summary);
  // keep current planning_docs pointing to latest content
  const id = `${project_id}:prd`;
  db.prepare(`INSERT INTO planning_docs (id, project_id, type, content, summary)
              VALUES (?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET content=excluded.content, summary=excluded.summary, updated_at=CURRENT_TIMESTAMP`)
    .run(id, project_id, 'prd', content, summary);
  return { success: true };
}

function getPrdVersions(db, input) {
  const { project_id } = input;
  const rows = db.prepare('SELECT version, created_at FROM planning_doc_versions WHERE project_id=? AND type=? ORDER BY id DESC').all(project_id, 'prd');
  return { versions: rows };
}

function switchPrdVersion(db, input) {
  const { project_id, version } = input;
  const row = db.prepare('SELECT content, summary FROM planning_doc_versions WHERE project_id=? AND type=? AND version=?').get(project_id, 'prd', version);
  if (!row) throw new Error('Version not found');
  const id = `${project_id}:prd`;
  db.prepare(`INSERT INTO planning_docs (id, project_id, type, content, summary)
              VALUES (?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET content=excluded.content, summary=excluded.summary, updated_at=CURRENT_TIMESTAMP`)
    .run(id, project_id, 'prd', row.content, row.summary);
  return { success: true };
}

module.exports.prdNew = prdNew;
module.exports.getPrdVersions = getPrdVersions;
module.exports.switchPrdVersion = switchPrdVersion;

// ---------- Epic Versioning ----------
function epicNewVersion(db, input) {
  const { project_id, epic_number, version, title, description, status } = input;
  db.prepare('INSERT OR REPLACE INTO epic_versions (project_id, epic_number, version, title, description, status) VALUES (?,?,?,?,?,?)')
    .run(project_id, epic_number, version, title || null, description || null, status || null);
  // Optionally update current epic fields to reflect latest
  const epic = db.prepare('SELECT id FROM epics WHERE project_id=? AND number=?').get(project_id, epic_number);
  if (epic) {
    db.prepare('UPDATE epics SET title=COALESCE(?,title), description=COALESCE(?,description), status=COALESCE(?,status), updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(title || null, description || null, status || null, epic.id);
  }
  return { success: true };
}

function getEpicVersions(db, input) {
  const { project_id, epic_number } = input;
  const rows = db.prepare('SELECT version, title, status, created_at FROM epic_versions WHERE project_id=? AND epic_number=? ORDER BY id DESC').all(project_id, epic_number);
  return { versions: rows };
}

function switchEpicVersion(db, input) {
  const { project_id, epic_number, version } = input;
  const row = db.prepare('SELECT title, description, status FROM epic_versions WHERE project_id=? AND epic_number=? AND version=?').get(project_id, epic_number, version);
  if (!row) throw new Error('Epic version not found');
  const epic = db.prepare('SELECT id FROM epics WHERE project_id=? AND number=?').get(project_id, epic_number);
  if (!epic) throw new Error('Epic not found');
  db.prepare('UPDATE epics SET title=?, description=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(row.title || null, row.description || null, row.status || null, epic.id);
  return { success: true };
}

function addEpicChangelog(db, input) {
  const { project_id, epic_number, entry } = input;
  db.prepare('INSERT INTO epic_changelog (project_id, epic_number, entry) VALUES (?,?,?)').run(project_id, epic_number, entry);
  return { success: true };
}

function getEpicChangelog(db, input) {
  const { project_id, epic_number, limit = 100 } = input;
  const rows = db.prepare('SELECT entry, created_at FROM epic_changelog WHERE project_id=? AND epic_number=? ORDER BY id DESC LIMIT ?').all(project_id, epic_number, limit);
  return { entries: rows };
}

// ---------- Review Sessions ----------
function startReview(db, input) {
  const { project_id, story_id, reviewer } = input;
  const id = `${project_id}:rev-${Date.now()}`;
  db.prepare("INSERT INTO review_sessions (id, project_id, story_id, reviewer, status) VALUES (?,?,?,?, 'open')")
    .run(id, project_id, story_id, reviewer || null);
  return { success: true, session_id: id };
}

function addReviewFinding(db, input) {
  const { session_id, severity, description, file, line } = input;
  const maxIdx = db.prepare('SELECT COALESCE(MAX(idx),0) AS m FROM review_findings WHERE session_id=?').get(session_id).m;
  const idx = maxIdx + 1;
  db.prepare("INSERT INTO review_findings (session_id, idx, severity, description, file, line, status) VALUES (?,?,?,?,?,?,'open')")
    .run(session_id, idx, severity || null, description, file || null, line || null);
  return { success: true, idx };
}

function updateReviewFinding(db, input) {
  const { session_id, idx, status } = input;
  const res = db.prepare('UPDATE review_findings SET status=? WHERE session_id=? AND idx=?').run(status, session_id, idx);
  return { success: res.changes > 0 };
}

function closeReview(db, input) {
  const { session_id, outcome } = input;
  db.prepare('UPDATE review_sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(outcome || 'closed', session_id);
  return { success: true };
}

function listReviews(db, input) {
  const { project_id, story_id, limit = 50 } = input;
  let sql = 'SELECT id, story_id, reviewer, status, created_at FROM review_sessions WHERE project_id=?';
  const params = [project_id];
  if (story_id) { sql += ' AND story_id=?'; params.push(story_id); }
  sql += ' ORDER BY id DESC LIMIT ?'; params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return { reviews: rows };
}

function reviewApprove(db, input) {
  const { session_id, role } = input;
  db.prepare('UPDATE review_sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('approved', session_id);
  return { success: true };
}

function reviewReject(db, input) {
  const { session_id, reason } = input;
  db.prepare('UPDATE review_sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('rejected', session_id);
  return { success: true };
}

// ---------- TEA / Test Engineering ----------
function createTestPlan(db, input) {
  const { project_id, story_id, title, content } = input;
  const id = `${project_id}:plan-${Date.now()}`;
  db.prepare('INSERT INTO test_plans (id, project_id, story_id, title, content, summary) VALUES (?,?,?,?,?,?)')
    .run(id, project_id, story_id || null, title, content || null, summarize(content || '', 800));
  return { success: true, plan_id: id };
}

function addTestCase(db, input) {
  const { plan_id, key, title, steps, expected } = input;
  db.prepare("INSERT INTO test_cases (plan_id, key, title, steps, expected, status) VALUES (?,?,?,?,?, 'unverified')")
    .run(plan_id, key || null, title, steps || null, expected || null);
  return { success: true };
}

function updateTestCase(db, input) {
  const { case_id, title, steps, expected, status } = input;
  const fields = [];
  const vals = [];
  if (title != null) { fields.push('title=?'); vals.push(title); }
  if (steps != null) { fields.push('steps=?'); vals.push(steps); }
  if (expected != null) { fields.push('expected=?'); vals.push(expected); }
  if (status != null) { fields.push('status=?'); vals.push(status); }
  if (!fields.length) return { success: true };
  vals.push(case_id);
  db.prepare(`UPDATE test_cases SET ${fields.join(', ')} WHERE id=?`).run(...vals);
  return { success: true };
}

function recordTestRun(db, input) {
  const { plan_id, run_id } = input;
  db.prepare('INSERT OR IGNORE INTO test_runs (plan_id, run_id) VALUES (?,?)').run(plan_id, run_id);
  return { success: true };
}

function recordTestResult(db, input) {
  const { case_id, run_id, status, notes } = input;
  db.prepare('INSERT INTO test_results (case_id, run_id, status, notes) VALUES (?,?,?,?)').run(case_id, run_id, status, notes || null);
  return { success: true };
}

function getTestCoverage(db, input) {
  const { plan_id } = input;
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM test_cases WHERE plan_id=? GROUP BY status').all(plan_id);
  const byStatus = Object.fromEntries(rows.map(r => [r.status, r.n]));
  const total = db.prepare('SELECT COUNT(*) AS n FROM test_cases WHERE plan_id=?').get(plan_id).n;
  return { total, by_status: byStatus };
}

module.exports.epicNewVersion = epicNewVersion;
module.exports.getEpicVersions = getEpicVersions;
module.exports.switchEpicVersion = switchEpicVersion;
module.exports.addEpicChangelog = addEpicChangelog;
module.exports.getEpicChangelog = getEpicChangelog;
module.exports.startReview = startReview;
module.exports.addReviewFinding = addReviewFinding;
module.exports.updateReviewFinding = updateReviewFinding;
module.exports.closeReview = closeReview;
module.exports.listReviews = listReviews;
module.exports.reviewApprove = reviewApprove;
module.exports.reviewReject = reviewReject;
module.exports.createTestPlan = createTestPlan;
module.exports.addTestCase = addTestCase;
module.exports.updateTestCase = updateTestCase;
module.exports.recordTestRun = recordTestRun;
module.exports.recordTestResult = recordTestResult;
module.exports.getTestCoverage = getTestCoverage;
