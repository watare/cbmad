const fs = require('fs');
const path = require('path');
const os = require('os');

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
  const { project_id, type, content, generate_summary, precondition_updated_at } = input;
  const id = `${project_id}:${type}`;
  const summary = generate_summary ? (content.slice(0, 800) + (content.length > 800 ? '...': '')) : null;
  if (precondition_updated_at) {
    const cur = db.prepare('SELECT updated_at FROM planning_docs WHERE id=?').get(id);
    if (cur && String(cur.updated_at) !== String(precondition_updated_at)) {
      return { success: false, conflict: true, current_updated_at: cur.updated_at };
    }
  }
  db.prepare(`INSERT INTO planning_docs (id, project_id, type, content, summary)
              VALUES (?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET content=excluded.content, summary=COALESCE(excluded.summary, planning_docs.summary), updated_at=CURRENT_TIMESTAMP`)
    .run(id, project_id, type, content, summary);
  const updated = db.prepare('SELECT updated_at FROM planning_docs WHERE id=?').get(id);
  return { success: true, updated_at: updated?.updated_at };
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
  const root = root_path || (db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id)?.root_path);
  if (!root) throw new Error('root_path required or register project first');
  registerProject(db, { id: project_id, name: project_id, root_path: root });
  const outDir = bmad_output_path || path.join(root, '_bmad-output');
  let importedStories = 0;
  let importedEpics = 0;
  let importedPlanning = 0;
  let importedLogs = 0;
  const warnings = [];

  function readIfExists(p) { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } }
  function pickFirst(paths) { for (const p of paths) { if (fs.existsSync(p)) return p; } return null; }

  // Epics from epics.md (classic export)
  const epicCandidates = [
    path.join(outDir, 'planning', 'epics.md'),
    path.join(outDir, 'planning-artifacts', 'epics.md'),
  ];
  const epicsMd = pickFirst(epicCandidates);
  if (epicsMd) {
    const txt = readIfExists(epicsMd) || '';
    for (const ln of (txt.split(/\r?\n/))) {
      const m = ln.match(/^\s*[-*]\s*Epic\s+(\d+)\s*[:\-]\s*(.+)$/i);
      if (m) {
        const num = parseInt(m[1], 10); const title = m[2].trim();
        const id = `${project_id}:epic-${num}`;
        db.prepare('INSERT OR IGNORE INTO epics (id, project_id, number, title, status) VALUES (?,?,?,?,?)').run(id, project_id, num, title, 'planned');
        importedEpics++;
      }
    }
  }

  // Stories from exports: _bmad-output/stories/*.md and implementation-artifacts/*.md
  function importStoriesFromDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const content = readIfExists(path.join(dir, f)) || '';
      let key = null, title = null;
      const h1 = content.match(/^#\s*(.+)$/m);
      if (h1) {
        // Patterns: "KEY — Title" or "KEY - Title" or just Title
        const m = h1[1].match(/^(\d+-\d+)\s*[—-]\s*(.+)$/);
        if (m) { key = m[1].trim(); title = m[2].trim(); }
        else if (/^\d+-\d+\b/.test(h1[1])) { key = h1[1].trim(); title = h1[1].trim(); }
        else { title = h1[1].trim(); }
      }
      key = key || path.basename(f, '.md');
      title = title || key;
      const storyId = `${project_id}:${key}`;
      db.prepare(`INSERT OR IGNORE INTO stories (id, project_id, key, title, status) VALUES (?,?,?,?, 'draft')`).run(storyId, project_id, key, title);
      importedStories++;
      // Parse acceptance criteria and tasks if present
      const acSection = content.split(/\n##\s+Acceptance Criteria\s*\n/i)[1];
      if (acSection) {
        const acLines = acSection.split(/\n##\s+/)[0].split(/\r?\n/).filter(l => /^-\s*\[.\]/.test(l));
        if (acLines.length) {
          const criteria = acLines.map(l => {
            const met = /\[x\]/i.test(l);
            const t = l.replace(/^\s*-\s*\[[ x]\]\s*/i, '').trim();
            return { criterion: t, met };
          });
          db.prepare('UPDATE stories SET acceptance_criteria=json(?), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(criteria), storyId);
        }
      }
      const tasksSection = content.split(/\n##\s+Tasks\s*\n/i)[1];
      if (tasksSection) {
        const block = tasksSection.split(/\n##\s+/)[0];
        const lines = block.split(/\r?\n/).filter(Boolean);
        let idx = 1; const ins = db.prepare('INSERT INTO tasks (story_id, idx, description, done) VALUES (?,?,?,?)');
        for (const l of lines) {
          const m = l.match(/^\s*-\s*\[([ x])\]\s*(?:\((\d+)\)\s*)?(.+)$/);
          if (!m) continue;
          const done = m[1].toLowerCase() === 'x' ? 1 : 0;
          const desc = (m[3] || m[2] || '').trim();
          ins.run(storyId, idx++, desc, done);
        }
      }
    }
  }
  importStoriesFromDir(path.join(outDir, 'stories'));
  importStoriesFromDir(path.join(outDir, 'implementation-artifacts'));

  // Planning docs across common locations
  const planningTypes = ['prd','architecture','ux','product_brief','nfr','test_design','atdd','traceability','ci_plan','tech_spec'];
  const nameMap = {
    prd: ['prd.md','PRD.md','ProductRequirements.md'],
    architecture: ['architecture.md','ARCHITECTURE.md','adr.md'],
    ux: ['ux.md','UX.md','design.md'],
    product_brief: ['product_brief.md','product-brief.md','brief.md'],
    nfr: ['nfr.md','nfr-assess.md','non-functional.md'],
    test_design: ['test-design.md','test_design.md'],
    atdd: ['atdd.md','acceptance-test-driven.md'],
    traceability: ['traceability.md','trace.md'],
    ci_plan: ['ci-plan.md','ci.md'],
    tech_spec: ['tech-spec.md','tech_spec.md','spec.md']
  };
  for (const t of planningTypes) {
    const candidates = [
      path.join(outDir, 'planning', `${t}.md`),
      path.join(outDir, 'planning-artifacts', `${t}.md`),
      ...((nameMap[t]||[]).map(n => path.join(root, 'docs', n))),
      ...((nameMap[t]||[]).map(n => path.join(root, n)))
    ];
    const p = pickFirst(candidates);
    if (p) {
      const txt = readIfExists(p) || '';
      updatePlanningDoc(db, { project_id, type: t, content: txt, generate_summary: true });
      importedPlanning++;
    }
  }

  // Logs
  const logsMd = pickFirst([
    path.join(outDir, 'logs', 'logs.md'),
  ]);
  if (logsMd) {
    const txt = readIfExists(logsMd) || '';
    const lines = txt.split(/\r?\n/);
    for (const ln of lines) {
      const m = ln.match(/^\s*-\s*([^\[]+)\s*\[([^\]]+)\]\s*(.+)$/);
      if (m) {
        const type = m[2].trim();
        const content = m[3].trim();
        db.prepare('INSERT INTO logs (project_id, story_id, type, content) VALUES (?,?,?,?)').run(project_id, null, type, content);
        importedLogs++;
      }
    }
  }

  return { success: true, imported: { epics: importedEpics, stories: importedStories, planning_docs: importedPlanning, logs: importedLogs }, warnings };
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
  const { story_id, title, description, epic_number, status, precondition_updated_at } = input;
  const s = db.prepare('SELECT project_id FROM stories WHERE id=?').get(story_id);
  if (!s) throw new Error('Story not found');
  if (precondition_updated_at) {
    const cur = db.prepare('SELECT updated_at FROM stories WHERE id=?').get(story_id);
    if (cur && String(cur.updated_at) !== String(precondition_updated_at)) {
      return { success: false, conflict: true, current_updated_at: cur.updated_at };
    }
  }
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
  const updated = db.prepare('SELECT updated_at FROM stories WHERE id=?').get(story_id);
  return { success: true, updated_at: updated?.updated_at };
}

function deleteStory(db, input) {
  const { story_id, force = false } = input;
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE story_id=? AND done=0').get(story_id).n;
  if (cnt > 0 && !force) {
    return { success: false, error: 'incomplete-tasks' };
  }
  // Clean references that do not cascade
  db.prepare('UPDATE bugs SET story_id=NULL WHERE story_id=?').run(story_id);
  db.prepare('DELETE FROM reservations WHERE story_id=?').run(story_id);
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

// ---------- Planning Docs generic versioning (arch, ux, epics-doc) ----------
function docNewVersion(db, input) {
  const { project_id, type, version, content } = input; // type: 'architecture' | 'ux' | 'epics'
  const summary = summarize(content, 1200);
  db.prepare('INSERT INTO planning_doc_versions (project_id, type, version, content, summary) VALUES (?,?,?,?,?)')
    .run(project_id, type, version, content, summary);
  const id = `${project_id}:${type}`;
  db.prepare(`INSERT INTO planning_docs (id, project_id, type, content, summary)
              VALUES (?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET content=excluded.content, summary=excluded.summary, updated_at=CURRENT_TIMESTAMP`)
    .run(id, project_id, type, content, summary);
  return { success: true };
}

function getDocVersions(db, input) {
  const { project_id, type } = input;
  const rows = db.prepare('SELECT version, created_at FROM planning_doc_versions WHERE project_id=? AND type=? ORDER BY id DESC').all(project_id, type);
  return { versions: rows };
}

function switchDocVersion(db, input) {
  const { project_id, type, version } = input;
  const row = db.prepare('SELECT content, summary FROM planning_doc_versions WHERE project_id=? AND type=? AND version=?').get(project_id, type, version);
  if (!row) throw new Error('Version not found');
  const id = `${project_id}:${type}`;
  db.prepare(`INSERT INTO planning_docs (id, project_id, type, content, summary)
              VALUES (?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET content=excluded.content, summary=excluded.summary, updated_at=CURRENT_TIMESTAMP`)
    .run(id, project_id, type, row.content, row.summary);
  return { success: true };
}

// ---------- Story Snapshots (with tasks) ----------
function storySnapshot(db, input) {
  const { story_id, version } = input;
  const s = db.prepare('SELECT id, title, description, status, acceptance_criteria, dev_notes FROM stories WHERE id=?').get(story_id);
  if (!s) throw new Error('Story not found');
  const roots = db.prepare('SELECT id, idx, description, done FROM tasks WHERE story_id=? AND parent_task_id IS NULL ORDER BY idx ASC').all(story_id);
  const subs = db.prepare('SELECT parent_task_id, idx, description, done FROM tasks WHERE story_id=? AND parent_task_id IS NOT NULL ORDER BY parent_task_id, idx ASC').all(story_id);
  const byParent = subs.reduce((a, r) => { (a[r.parent_task_id] ||= []).push(r); return a; }, {});
  const snap = roots.map(r => ({ idx: r.idx, description: r.description, done: !!r.done, subtasks: (byParent[r.id]||[]).map(x=>({ idx:x.idx, description:x.description, done:!!x.done })) }));
  db.prepare('INSERT OR REPLACE INTO story_versions (story_id, version, title, description, status, acceptance_criteria, dev_notes, tasks_snapshot) VALUES (?,?,?,?,?,?,?,?)')
    .run(story_id, version, s.title, s.description || null, s.status, s.acceptance_criteria || '[]', s.dev_notes || null, JSON.stringify(snap));
  return { success: true };
}

function getStoryVersions(db, input) {
  const { story_id } = input;
  const rows = db.prepare('SELECT version, created_at FROM story_versions WHERE story_id=? ORDER BY id DESC').all(story_id);
  return { versions: rows };
}

function switchStoryVersion(db, input) {
  const { story_id, version } = input;
  const v = db.prepare('SELECT title, description, status, acceptance_criteria, dev_notes, tasks_snapshot FROM story_versions WHERE story_id=? AND version=?').get(story_id, version);
  if (!v) throw new Error('Version not found');
  db.prepare('UPDATE stories SET title=?, description=?, status=?, acceptance_criteria=?, dev_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(v.title || null, v.description || null, v.status || 'draft', v.acceptance_criteria || '[]', v.dev_notes || null, story_id);
  // Replace tasks from snapshot
  const del = db.prepare('DELETE FROM tasks WHERE story_id=?');
  del.run(story_id);
  const roots = JSON.parse(v.tasks_snapshot || '[]');
  const insRoot = db.prepare('INSERT INTO tasks (story_id, idx, description, done) VALUES (?,?,?,?)');
  const insSub = db.prepare('INSERT INTO tasks (story_id, parent_task_id, idx, description, done) VALUES (?,?,?,?,?)');
  for (const r of roots) {
    const res = insRoot.run(story_id, r.idx, r.description, r.done ? 1 : 0);
    const parentId = res.lastInsertRowid;
    for (const st of (r.subtasks || [])) insSub.run(story_id, parentId, st.idx, st.description, st.done ? 1 : 0);
  }
  return { success: true };
}

module.exports.docNewVersion = docNewVersion;
module.exports.getDocVersions = getDocVersions;
module.exports.switchDocVersion = switchDocVersion;
module.exports.storySnapshot = storySnapshot;
module.exports.getStoryVersions = getStoryVersions;
module.exports.switchStoryVersion = switchStoryVersion;

// ---------- Discovery / Research / Brainstorm ----------
function startResearchSession(db, input) {
  const { project_id, topic } = input;
  const id = `${project_id}:rs-${Date.now()}`;
  db.prepare("INSERT INTO research_sessions (id, project_id, topic, status) VALUES (?,?,?, 'open')")
    .run(id, project_id, topic || null);
  return { success: true, session_id: id };
}

function addResearchNote(db, input) {
  const { session_id, type, content, tags } = input;
  db.prepare('INSERT INTO research_notes (session_id, type, content, tags) VALUES (?,?,?,?)')
    .run(session_id, type || null, content, (tags || []).join(','));
  return { success: true };
}

function listResearchNotes(db, input) {
  const { session_id, project_id } = input;
  if (session_id) {
    const rows = db.prepare('SELECT id, type, content, tags, created_at FROM research_notes WHERE session_id=? ORDER BY id ASC').all(session_id);
    return { notes: rows };
  }
  // aggregate over sessions by project
  const rows = db.prepare(`SELECT rn.id, rs.id AS session_id, rn.type, rn.content, rn.tags, rn.created_at
                           FROM research_notes rn JOIN research_sessions rs ON rs.id=rn.session_id
                           WHERE rs.project_id=? ORDER BY rn.id ASC`).all(project_id);
  return { notes: rows };
}

function addIdea(db, input) {
  const { project_id, title, description, score, status } = input;
  db.prepare('INSERT INTO ideas (project_id, title, description, score, status) VALUES (?,?,?,?,?)')
    .run(project_id, title, description || null, score || null, status || 'open');
  return { success: true };
}

function listIdeas(db, input) {
  const { project_id, status } = input;
  let sql = 'SELECT id, title, description, score, status FROM ideas WHERE project_id=?';
  const params = [project_id];
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY COALESCE(score,0) DESC, id DESC';
  const rows = db.prepare(sql).all(...params);
  return { ideas: rows };
}

// ---------- UX Validation ----------
function startUxReview(db, input) {
  const { project_id, version, reviewer } = input;
  const id = `${project_id}:uxr-${Date.now()}`;
  db.prepare("INSERT INTO ux_reviews (id, project_id, version, reviewer, status) VALUES (?,?,?,?,'open')")
    .run(id, project_id, version || null, reviewer || null);
  return { success: true, review_id: id };
}

function approveUxReview(db, input) {
  const { review_id, notes } = input;
  db.prepare("UPDATE ux_reviews SET status='approved', notes=? WHERE id=?").run(notes || null, review_id);
  return { success: true };
}

function rejectUxReview(db, input) {
  const { review_id, notes } = input;
  db.prepare("UPDATE ux_reviews SET status='rejected', notes=? WHERE id=?").run(notes || null, review_id);
  return { success: true };
}

function listUxReviews(db, input) {
  const { project_id, version } = input;
  let sql = 'SELECT id, version, reviewer, status, notes, created_at FROM ux_reviews WHERE project_id=?';
  const params = [project_id];
  if (version) { sql += ' AND version=?'; params.push(version); }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...params);
  return { reviews: rows };
}

// ---------- Implementation Readiness ----------
function defaultReadinessChecklist() {
  return [
    { key: 'tests', label: 'Automated tests in place', met: false },
    { key: 'docs', label: 'Docs updated', met: false },
    { key: 'security', label: 'Security review passed', met: false },
    { key: 'performance', label: 'Performance acceptable', met: false },
    { key: 'risks', label: 'Risks addressed', met: false }
  ];
}

function startReadiness(db, input) {
  const { project_id, story_id, epic_number } = input;
  const id = `${project_id}:ready-${Date.now()}`;
  const checklist = defaultReadinessChecklist();
  db.prepare("INSERT INTO readiness_checks (id, project_id, story_id, epic_number, checklist, status) VALUES (?,?,?,?,?, 'open')")
    .run(id, project_id, story_id || null, epic_number || null, JSON.stringify(checklist));
  return { success: true, readiness_id: id, checklist };
}

function updateReadinessItem(db, input) {
  const { readiness_id, key, met } = input;
  const row = db.prepare('SELECT checklist FROM readiness_checks WHERE id=?').get(readiness_id);
  if (!row) throw new Error('Readiness not found');
  const list = JSON.parse(row.checklist || '[]');
  for (const item of list) if (item.key === key) item.met = !!met;
  db.prepare('UPDATE readiness_checks SET checklist=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(JSON.stringify(list), readiness_id);
  return { success: true };
}

function getReadinessStatus(db, input) {
  const { readiness_id } = input;
  const row = db.prepare('SELECT checklist, status FROM readiness_checks WHERE id=?').get(readiness_id);
  if (!row) throw new Error('Readiness not found');
  const list = JSON.parse(row.checklist || '[]');
  const total = list.length;
  const met = list.filter(i => i.met).length;
  const all_met = met === total && total > 0;
  return { status: row.status, progress: { met, total }, all_met, checklist: list };
}

function finalizeReadiness(db, input) {
  const { readiness_id } = input;
  const st = getReadinessStatus(db, { readiness_id });
  const status = st.all_met ? 'passed' : 'failed';
  db.prepare('UPDATE readiness_checks SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, readiness_id);
  return { success: true, status };
}

module.exports.startResearchSession = startResearchSession;
module.exports.addResearchNote = addResearchNote;
module.exports.listResearchNotes = listResearchNotes;
module.exports.addIdea = addIdea;
module.exports.listIdeas = listIdeas;
module.exports.startUxReview = startUxReview;
module.exports.approveUxReview = approveUxReview;
module.exports.rejectUxReview = rejectUxReview;
module.exports.listUxReviews = listUxReviews;
// Provide missing listResearchSessions implementation
function listResearchSessions(db, input) {
  const { project_id, status } = input || {};
  if (!project_id) throw new Error('project_id required');
  let sql = 'SELECT id, topic, status, created_at FROM research_sessions WHERE project_id=?';
  const params = [project_id];
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...params);
  return { sessions: rows };
}
module.exports.startReadiness = startReadiness;
module.exports.updateReadinessItem = updateReadinessItem;
module.exports.getReadinessStatus = getReadinessStatus;
module.exports.finalizeReadiness = finalizeReadiness;
module.exports.listProjects = function(db){ return listProjects(db); };
module.exports.listResearchSessions = listResearchSessions;

// ---------- Components Registry & Export ----------
const cp = require('child_process');

function componentId(project_id, name) { return `${project_id}:comp:${name}`; }

function registerComponent(db, input) {
  const { project_id, name, type, version, description, tags, files, target_repo, target_path } = input;
  if (!project_id || !name || !type) throw new Error('project_id, name, type required');
  const id = componentId(project_id, name);
  db.prepare(`INSERT INTO components (id, project_id, name, type, version, description, tags, target_repo, target_path)
              VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET version=excluded.version, description=excluded.description, tags=excluded.tags, target_repo=excluded.target_repo, target_path=excluded.target_path, updated_at=CURRENT_TIMESTAMP`)
    .run(id, project_id, name, type, version || null, description || null, (tags || []).join(','), target_repo || null, target_path || null);
  // store file list (reset then insert)
  db.prepare('DELETE FROM component_files WHERE component_id=?').run(id);
  const ins = db.prepare('INSERT INTO component_files (component_id, rel_path) VALUES (?,?)');
  for (const f of files || []) ins.run(id, f.path || f);
  return { success: true, component_id: id };
}

function listComponents(db, input) {
  const { project_id } = input;
  let sql = 'SELECT id, project_id, name, type, version, description, tags, target_repo, target_path, updated_at FROM components';
  const params = [];
  if (project_id) { sql += ' WHERE project_id=?'; params.push(project_id); }
  sql += ' ORDER BY updated_at DESC';
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, tags: (r.tags || '').split(',').filter(Boolean) }));
  return { components: rows };
}

function generateComponentReadme(meta, files) {
  const lines = [];
  lines.push(`# ${meta.name}`);
  if (meta.description) { lines.push('', meta.description); }
  lines.push('', '## Metadata');
  lines.push(`- Type: ${meta.type}`);
  if (meta.version) lines.push(`- Version: ${meta.version}`);
  if (meta.tags?.length) lines.push(`- Tags: ${meta.tags.join(', ')}`);
  lines.push('', '## Files');
  for (const f of files) lines.push(`- ${f}`);
  lines.push('', '## Usage');
  lines.push('Describe how to import/use this component in consuming projects.');
  return lines.join('\n');
}

function exportComponent(db, input) {
  const { component_id, output_dir } = input;
  const c = db.prepare('SELECT * FROM components WHERE id=?').get(component_id);
  if (!c) throw new Error('Component not found');
  const files = db.prepare('SELECT rel_path FROM component_files WHERE component_id=? ORDER BY id ASC').all(component_id).map(r => r.rel_path);
  const proj = db.prepare('SELECT root_path FROM projects WHERE id=?').get(c.project_id);
  const root = proj?.root_path;
  if (!root) throw new Error('Project root_path not set');
  const base = output_dir || path.join(root, '_bmad-output', 'components', c.name);
  ensureDir(base);
  // copy files preserving relative structure
  for (const rel of files) {
    const src = path.join(root, rel);
    const dst = path.join(base, rel);
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
  }
  const readme = generateComponentReadme({ name: c.name, type: c.type, version: c.version, description: c.description, tags: (c.tags || '').split(',').filter(Boolean) }, files);
  fs.writeFileSync(path.join(base, 'README.md'), readme, 'utf8');
  return { success: true, path: base };
}

function commitComponent(db, input) {
  const { component_id, repo_url, branch = 'main', target_subdir = 'components', dry_run = false } = input;
  const c = db.prepare('SELECT * FROM components WHERE id=?').get(component_id);
  if (!c) throw new Error('Component not found');
  const proj = db.prepare('SELECT root_path FROM projects WHERE id=?').get(c.project_id);
  const root = proj?.root_path;
  if (!root) throw new Error('Project root_path not set');
  // Export to temp dir first
  const tmp = fs.mkdtempSync(path.join(os.tmpdir?.() || '/tmp', 'bmad-comp-'));
  const exp = exportComponent(db, { component_id, output_dir: tmp });
  const localBase = process.env.BMAD_COMPONENTS_DIR || path.join(os.homedir(), '.config', 'bmad-server', 'components');
  ensureDir(localBase);
  const repoName = (c.type === 'front' ? 'frontcomponent' : 'backcomponent');
  const repoDir = path.join(localBase, repoName);
  const cmds = [];
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    ensureDir(repoDir);
    cmds.push(['git', 'clone', repo_url || `git@github.com:watare/${repoName}.git`, repoDir]);
  } else {
    cmds.push(['git', '-C', repoDir, 'fetch']);
    cmds.push(['git', '-C', repoDir, 'checkout', branch]);
    cmds.push(['git', '-C', repoDir, 'pull', '--rebase']);
  }
  const dest = path.join(repoDir, target_subdir, c.name);
  cmds.push(['bash', '-lc', `rm -rf ${JSON.stringify(dest)} && mkdir -p ${JSON.stringify(dest)}`]);
  cmds.push(['bash', '-lc', `cp -R ${JSON.stringify(exp.path + '/.')} ${JSON.stringify(dest)}`]);
  const msg = input.commit_message || `feat(${c.name}): publish ${c.type} component from ${c.project_id}`;
  cmds.push(['git', '-C', repoDir, 'add', '.']);
  cmds.push(['git', '-C', repoDir, 'commit', '-m', msg]);
  cmds.push(['git', '-C', repoDir, 'push', 'origin', branch]);
  if (dry_run) {
    return { success: true, commands: cmds.map(a => a.join(' ')), target: dest };
  }
  for (const a of cmds) {
    try { cp.execFileSync(a[0], a.slice(1), { stdio: 'inherit' }); } catch (e) { throw new Error(`Command failed: ${a.join(' ')}\n${e.message}`); }
  }
  return { success: true, repo_dir: repoDir, target_path: dest };
}

module.exports.registerComponent = registerComponent;
module.exports.listComponents = listComponents;
module.exports.exportComponent = exportComponent;
module.exports.commitComponent = commitComponent;

// ---------- Project Status (composite) ----------
function getProjectStatus(db, input) {
  const { project_id, name, root_path, config } = input || {};
  if (!project_id) throw new Error('project_id required');
  let proj = db.prepare('SELECT id, name, root_path, config, created_at, updated_at FROM projects WHERE id=?').get(project_id);
  if (!proj) {
    if (root_path) {
      registerProject(db, { id: project_id, name: name || project_id, root_path, config: config || {} });
      proj = db.prepare('SELECT id, name, root_path, config, created_at, updated_at FROM projects WHERE id=?').get(project_id);
    } else {
      return { found: false, needs_registration: true };
    }
  }
  const cfg = proj.config ? JSON.parse(proj.config) : null;
  const statsRow = db.prepare('SELECT COUNT(*) AS epics FROM epics WHERE project_id=?').get(project_id);
  const storiesCount = db.prepare('SELECT COUNT(*) AS stories FROM stories WHERE project_id=?').get(project_id);
  const byStatusRows = db.prepare('SELECT status, COUNT(*) AS n FROM stories WHERE project_id=? GROUP BY status').all(project_id);
  const byStatus = Object.fromEntries(byStatusRows.map(r => [r.status, r.n]));
  const sprint = db.prepare('SELECT current_sprint FROM sprint_status WHERE project_id=?').get(project_id);
  const sessions = db.prepare('SELECT id, topic, status, created_at FROM research_sessions WHERE project_id=? ORDER BY id DESC LIMIT 5').all(project_id);
  const prd = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='prd'").get(project_id);
  const arch = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='architecture'").get(project_id);
  const ux = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='ux'").get(project_id);
  const brief = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='product_brief'").get(project_id);
  const nfr = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='nfr'").get(project_id);
  const testDesign = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='test_design'").get(project_id);
  const atdd = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='atdd'").get(project_id);
  const trace = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='traceability'").get(project_id);
  const ciPlan = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='ci_plan'").get(project_id);
  const techSpec = db.prepare("SELECT id FROM planning_docs WHERE project_id=? AND type='tech_spec'").get(project_id);
  const gates = db.prepare('SELECT status, COUNT(*) AS n FROM phase_gates WHERE project_id=? GROUP BY status').all(project_id);
  const gates_by_status = Object.fromEntries(gates.map(r => [r.status, r.n]));
  return {
    found: true,
    project: { id: proj.id, name: proj.name, root_path: proj.root_path, config: cfg },
    summary: {
      current_sprint: sprint ? sprint.current_sprint : null,
      counts: { epics: statsRow.epics, stories: storiesCount.stories },
      stories_by_status: byStatus
    },
    discovery: { recent_sessions: sessions },
    planning_flags: { has_prd: !!prd, has_architecture: !!arch, has_ux: !!ux, has_product_brief: !!brief, has_nfr: !!nfr, has_test_design: !!testDesign, has_atdd: !!atdd, has_traceability: !!trace, has_ci_plan: !!ciPlan, has_tech_spec: !!techSpec },
    phase_gates: { by_status: gates_by_status }
  };
}

module.exports.getProjectStatus = getProjectStatus;

// ---------- Retrospective ----------
function retroLog(db, input) {
  const { project_id, epic_number, content } = input;
  const epicInfo = epic_number != null ? ` [epic ${epic_number}]` : '';
  const entry = `[RETRO${epicInfo}] ${content}`;
  db.prepare('INSERT INTO logs (project_id, story_id, type, content) VALUES (?,?,?,?)')
    .run(project_id, null, 'retro', entry);
  return { success: true };
}

// ---------- Diagram stubs (Excalidraw-friendly placeholders) ----------
function createDiagramDoc(db, input, kind) {
  const { project_id, title, content } = input;
  const docTitle = title || `${kind} diagram`;
  const body = content || `# ${docTitle}\n\nThis is a placeholder for a ${kind} diagram.\n\n- Tool: Excalidraw\n- Export: add .excalidraw file alongside when available.`;
  const tags = `diagram,${kind},excalidraw`;
  db.prepare(`INSERT INTO documents (project_id, path, type, tags, content, summary)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(project_id, path) DO UPDATE SET type=excluded.type, tags=excluded.tags, content=excluded.content, summary=excluded.summary, updated_at=CURRENT_TIMESTAMP`)
    .run(project_id, `planning/diagrams/${kind}-${Date.now()}.md`, 'diagram', tags, body, summarize(body, 400));
  return { success: true };
}

function createDataflow(db, input) { return createDiagramDoc(db, input, 'dataflow'); }
function createDiagram(db, input) { return createDiagramDoc(db, input, 'diagram'); }
function createFlowchart(db, input) { return createDiagramDoc(db, input, 'flowchart'); }
function createWireframe(db, input) { return createDiagramDoc(db, input, 'wireframe'); }

// ---------- Sprint Planning Generation (basic) ----------
function sprintPlanningGenerate(db, input) {
  const { project_id, epic_numbers, current_sprint } = input;
  if (current_sprint) {
    db.prepare(`INSERT INTO sprint_status (project_id, current_sprint, status_data, updated_at)
                VALUES (?,?,NULL,CURRENT_TIMESTAMP)
                ON CONFLICT(project_id) DO UPDATE SET current_sprint=excluded.current_sprint, updated_at=CURRENT_TIMESTAMP`)
      .run(project_id, current_sprint);
  }
  // Build a basic plan of candidate stories: ready-for-dev or draft under selected epics (if provided)
  let sql = `SELECT s.key, s.title, s.status, e.number AS epic_number
             FROM stories s LEFT JOIN epics e ON s.epic_id=e.id
             WHERE s.project_id=?`;
  const params = [project_id];
  if (epic_numbers && epic_numbers.length) {
    sql += ` AND e.number IN (${epic_numbers.map(()=>'?').join(',')})`;
    params.push(...epic_numbers);
  }
  sql += ` AND s.status IN ('ready-for-dev','draft') ORDER BY e.number ASC, s.key ASC`;
  const rows = db.prepare(sql).all(...params);
  const plan = { generated_at: new Date().toISOString(), stories: rows };
  db.prepare(`INSERT INTO sprint_status (project_id, current_sprint, status_data, updated_at)
              VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(project_id) DO UPDATE SET status_data=excluded.status_data, updated_at=CURRENT_TIMESTAMP`)
    .run(project_id, current_sprint || null, JSON.stringify(plan));
  return { success: true, plan };
}

module.exports.retroLog = retroLog;
module.exports.createDataflow = createDataflow;
module.exports.createDiagram = createDiagram;
module.exports.createFlowchart = createFlowchart;
module.exports.createWireframe = createWireframe;
module.exports.sprintPlanningGenerate = sprintPlanningGenerate;

// ---------- Workflow Init (composite convenience) ----------
function workflowInit(db, input) {
  const { project_id, name, root_path, current_sprint, scan_docs = true, seed = {} } = input;
  if (!project_id) throw new Error('project_id required');
  if (root_path) registerProject(db, { id: project_id, name: name || project_id, root_path, config: {} });
  if (current_sprint) setCurrentSprint(db, { project_id, current_sprint });
  const actions = [];
  if (scan_docs) { scanDocuments(db, { project_id, root_path }); actions.push('docs_scanned'); }
  if (seed.prd) { updatePlanningDoc(db, { project_id, type: 'prd', content: seed.prd, generate_summary: true }); actions.push('prd_seeded'); }
  if (seed.architecture) { updatePlanningDoc(db, { project_id, type: 'architecture', content: seed.architecture, generate_summary: true }); actions.push('arch_seeded'); }
  if (seed.ux) { updatePlanningDoc(db, { project_id, type: 'ux', content: seed.ux, generate_summary: true }); actions.push('ux_seeded'); }
  if (seed.product_brief) { updatePlanningDoc(db, { project_id, type: 'product_brief', content: seed.product_brief, generate_summary: true }); actions.push('product_brief_seeded'); }
  if (seed.nfr) { updatePlanningDoc(db, { project_id, type: 'nfr', content: seed.nfr, generate_summary: true }); actions.push('nfr_seeded'); }
  if (seed.test_design) { updatePlanningDoc(db, { project_id, type: 'test_design', content: seed.test_design, generate_summary: true }); actions.push('test_design_seeded'); }
  if (seed.atdd) { updatePlanningDoc(db, { project_id, type: 'atdd', content: seed.atdd, generate_summary: true }); actions.push('atdd_seeded'); }
  if (seed.traceability) { updatePlanningDoc(db, { project_id, type: 'traceability', content: seed.traceability, generate_summary: true }); actions.push('traceability_seeded'); }
  if (seed.ci_plan) { updatePlanningDoc(db, { project_id, type: 'ci_plan', content: seed.ci_plan, generate_summary: true }); actions.push('ci_plan_seeded'); }
  if (seed.tech_spec) { updatePlanningDoc(db, { project_id, type: 'tech_spec', content: seed.tech_spec, generate_summary: true }); actions.push('tech_spec_seeded'); }
  const status = getProjectStatus(db, { project_id });
  return { success: true, actions, status };
}

module.exports.workflowInit = workflowInit;

// ---------- BMAD-METHOD Workflows Installation & Runner ----------
function copyDir(src, dst) {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

function installBmadMethod(db, input) {
  const { project_id, root_path, ref = 'main', target = 'project' } = input;
  let root = root_path;
  if (!root) {
    const r = db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id);
    if (!r) throw new Error('Project not found');
    root = r.root_path;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir?.() || '/tmp', 'bmad-method-'));
  try {
    cp.execFileSync('git', ['clone', '--depth', '1', '--branch', ref, 'https://github.com/bmad-code-org/BMAD-METHOD', tmp], { stdio: 'inherit' });
  } catch (e) {
    throw new Error('Git clone failed: ' + e.message);
  }
  const srcBmm = path.join(tmp, 'src', 'bmm');
  const dstBmm = target === 'project' ? path.join(root, '_bmad', 'bmm') : path.join(os.homedir(), '.config', 'bmad-server', 'bmm');
  ensureDir(dstBmm);
  // Copy workflows and supporting files
  const srcWorkflows = path.join(srcBmm, 'workflows');
  const dstWorkflows = path.join(dstBmm, 'workflows');
  copyDir(srcWorkflows, dstWorkflows);
  // module-help.csv for mapping
  const moduleHelp = path.join(srcBmm, 'module-help.csv');
  if (fs.existsSync(moduleHelp)) {
    fs.copyFileSync(moduleHelp, path.join(dstBmm, 'module-help.csv'));
  }
  return { success: true, installed_path: dstBmm };
}

function parseCsv(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') inQ = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function listWorkflows(db, input) {
  const { project_id, target = 'project' } = input;
  const root = target === 'project'
    ? (db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id)?.root_path)
    : path.join(os.homedir(), '.config', 'bmad-server');
  if (!root) throw new Error('Project not found');
  const csvPath = target === 'project'
    ? path.join(root, '_bmad', 'bmm', 'module-help.csv')
    : path.join(root, 'bmm', 'module-help.csv');
  if (!fs.existsSync(csvPath)) return { workflows: [] };
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines.shift();
  const workflows = [];
  for (const ln of lines) {
    const cols = parseCsv(ln);
    const [module, phase, name, code, seq, wfFile, command, required, agent, options, description] = cols;
    workflows.push({ module, phase, name, code, seq: Number(seq || 0), workflow_file: wfFile, command, required: String(required||'').toLowerCase()==='true', agent, options, description });
  }
  return { workflows };
}

function resolveWorkflowPath(db, project_id, wfFile, target) {
  const root = target === 'project'
    ? (db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id)?.root_path)
    : path.join(os.homedir(), '.config', 'bmad-server');
  if (!root) throw new Error('Project not found');
  const base = target === 'project' ? path.join(root, '_bmad', 'bmm') : path.join(root, 'bmm');
  return path.join(base, 'workflows', wfFile.replace(/^.*workflows\//, ''));
}

function openWorkflow(db, input) {
  const { project_id, code, target = 'project' } = input;
  const lw = listWorkflows(db, { project_id, target });
  const wf = lw.workflows.find(w => w.command === code || w.code === code);
  if (!wf) return { found: false };
  const fullPath = resolveWorkflowPath(db, project_id, wf.workflow_file, target);
  if (!fs.existsSync(fullPath)) return { found: false };
  const content = fs.readFileSync(fullPath, 'utf8');
  return { found: true, workflow: { ...wf, path: fullPath, content } };
}

function nextStep(db, input) {
  const { project_id, code, cursor = 0, target = 'project' } = input;
  const ow = openWorkflow(db, { project_id, code, target });
  if (!ow.found) return { found: false };
  const content = ow.workflow.content;
  // simple splitter: sections by level-2 headers
  const sections = content.split(/\n##\s+/).filter(Boolean);
  const idx = Math.min(Math.max(0, cursor), sections.length - 1);
  const titlePlus = sections[idx];
  const title = titlePlus.split('\n',1)[0].trim();
  const body = titlePlus.slice(title.length).trim();
  const hasNext = idx < sections.length - 1;
  return { found: true, step: { index: idx, title, body }, has_next: hasNext };
}

module.exports.installBmadMethod = installBmadMethod;
module.exports.listWorkflows = listWorkflows;
module.exports.openWorkflow = openWorkflow;
module.exports.nextStep = nextStep;

// ---------- Workflow Mapping (Quick Reference) ----------
function generateWorkflowMapping(db, input) {
  const { project_id, target = 'project' } = input;
  const root = target === 'project'
    ? (db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id)?.root_path)
    : path.join(os.homedir(), '.config', 'bmad-server');
  if (!root) throw new Error('Project not found');
  const csvPath = target === 'project'
    ? path.join(root, '_bmad', 'bmm', 'module-help.csv')
    : path.join(root, 'bmm', 'module-help.csv');
  if (!fs.existsSync(csvPath)) return { mappings: [] };
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean);
  lines.shift(); // header
  const rows = [];
  for (const ln of lines) {
    const cols = parseCsv(ln);
    const [module, phase, name, code, seq, wfFile, command, required, agent] = cols;
    if (!command) continue;
    rows.push({
      command,
      name,
      phase,
      agent,
      required: String(required||'').toLowerCase()==='true',
      runner_calls: {
        list: 'bmad.list_workflows',
        open: `bmad.open_workflow({ project_id, code: '${command}' })`,
        next: `bmad.next_step({ project_id, code: '${command}', cursor })`
      }
    });
  }
  return { mappings: rows };
}

module.exports.generateWorkflowMapping = generateWorkflowMapping;

// ---------- Optional Workflows helper ----------
function listOptionalWorkflows(db, input) {
  const { project_id, target = 'project' } = input;
  const lw = listWorkflows(db, { project_id, target });
  const optionals = (lw.workflows || []).filter(w => w.required === false || String(w.required).toLowerCase() === 'false');
  return { workflows: optionals };
}
module.exports.listOptionalWorkflows = listOptionalWorkflows;

// ---------- Save Workflow Output (generic) ----------
function saveWorkflowOutput(db, input) {
  const { project_id, code, title, content, tags = [] } = input;
  if (!project_id || !code || !content) throw new Error('project_id, code, content required');
  const name = title || code;
  const safeCode = code.replace(/[^a-zA-Z0-9-_:.]/g, '_');
  const relPath = `planning/outputs/${safeCode}-${Date.now()}.md`;
  const summary = summarize(content, 800);
  db.prepare('INSERT INTO documents (project_id, path, type, tags, content, summary) VALUES (?,?,?,?,?,?)')
    .run(project_id, relPath, 'workflow_output', [code, ...tags].join(','), `# ${name}\n\n${content}\n`, summary);
  return { success: true, path: relPath };
}
module.exports.saveWorkflowOutput = saveWorkflowOutput;

// ---------- Exports: Planning Docs to MD/HTML/PDF ----------
function preprocessMermaid(markdown) {
  return (markdown || '').replace(/```mermaid\n([\s\S]*?)```/g, (m, code) => `\n<div class=\"mermaid\">\n${code}\n</div>\n`);
}

function renderMarkdownHtml(title, markdown) {
  const pre = preprocessMermaid(markdown || '');
  let bodyHtml = '';
  try {
    const MarkdownIt = require('markdown-it');
    const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
    bodyHtml = md.render(pre);
  } catch (e) {
    bodyHtml = `<pre>${(pre || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</pre>`;
  }
  const html = `<!doctype html>\n<html>\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n  <title>${title || 'Document'}</title>\n  <style>\n    body { max-width: 860px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.55; }\n    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace; }\n    table { border-collapse: collapse; }\n    table, th, td { border: 1px solid #ccc; }\n    th, td { padding: 6px 10px; }\n    h1,h2,h3 { line-height: 1.25; }\n  </style>\n  <script>\n    window.MathJax = { tex: { inlineMath: [['$', '$'], ['\\\(', '\\\)']] } };\n  </script>\n  <script src=\"https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js\" async></script>\n  <script src=\"https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js\"></script>\n  <script>mermaid.initialize({ startOnLoad: true, theme: 'default' });</script>\n</head>\n<body>\n${bodyHtml}\n</body>\n</html>`;
  return html;
}

function exportPlanningDoc(db, input, { exportDir }) {
  const { project_id, type, format = 'md', output_path, title } = input;
  const row = db.prepare('SELECT content FROM planning_docs WHERE project_id=? AND type=?').get(project_id, type);
  if (!row) throw new Error('Planning doc not found');
  const proj = db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id);
  const baseDefault = proj?.root_path ? path.join(proj.root_path, '_bmad-output', 'planning') : path.join(exportDir, project_id, 'planning');
  const outPath = output_path || path.join(baseDefault, `${type}.${format}`);
  ensureDir(path.dirname(outPath));
  if (format === 'md') {
    fs.writeFileSync(outPath, row.content || '', 'utf8');
    return { success: true, path: outPath };
  }
  if (format === 'html') {
    const html = renderMarkdownHtml(title || type.toUpperCase(), row.content || '');
    fs.writeFileSync(outPath, html, 'utf8');
    return { success: true, path: outPath };
  }
  if (format === 'pdf') {
    const html = renderMarkdownHtml(title || type.toUpperCase(), row.content || '');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir?.() || '/tmp', 'bmad-html-'));
    const tmpHtml = path.join(tmpDir, `${type}.html`);
    fs.writeFileSync(tmpHtml, html, 'utf8');
    try {
      const puppeteer = require('puppeteer');
      return (async () => {
        const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto('file://' + tmpHtml, { waitUntil: 'networkidle0' });
        const waitMs = Number(process.env.BMAD_PDF_RENDER_WAIT_MS || 1200);
        await page.waitForTimeout(waitMs);
        await page.pdf({ path: outPath, format: 'A4', printBackground: true });
        await browser.close();
        return { success: true, path: outPath };
      })();
    } catch (e) {
      return { success: false, error: 'pdf-deps-missing', detail: 'Install puppeteer to enable PDF export', suggested_command: 'npm i puppeteer' };
    }
  }
  throw new Error('Unsupported format: ' + format);
}

function exportDocs(db, input, { exportDir }) {
  const { project_id, types, formats = ['md'] } = input;
  const rows = db.prepare('SELECT type FROM planning_docs WHERE project_id=?').all(project_id);
  const allTypes = rows.map(r => r.type);
  const chosen = Array.isArray(types) && types.length ? types : allTypes;
  const results = [];
  for (const t of chosen) {
    for (const f of (formats || ['md'])) {
      try {
        const r = exportPlanningDoc(db, { project_id, type: t, format: f }, { exportDir });
        if (r && typeof r.then === 'function') {
          results.push({ type: t, format: f, ok: true, path: '(pdf-in-progress)' });
        } else {
          results.push({ type: t, format: f, ok: !!r.success, path: r.path || null, error: r.error || null });
        }
      } catch (e) {
        results.push({ type: t, format: f, ok: false, error: String(e && e.message || e) });
      }
    }
  }
  return { success: true, results };
}

module.exports.exportPlanningDoc = exportPlanningDoc;
module.exports.exportDocs = exportDocs;

// ---------- Wireframes Portfolio Generator ----------
function firstHeading(md) {
  const m = (md || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function detectImageForDoc(projectRoot, docPath) {
  const full = path.join(projectRoot, docPath);
  const base = full.replace(/\.md$/i, '');
  const candidates = [base + '.png', base + '.jpg', base + '.jpeg', base + '.svg'];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  // Try same dir with same basename but any extension
  const dir = path.dirname(full);
  const name = path.basename(base);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const lower = f.toLowerCase();
      if (lower.startsWith(name.toLowerCase()) && (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.svg'))) {
        return path.join(dir, f);
      }
    }
  }
  return null;
}

function relPath(from, to) {
  try { return path.relative(path.dirname(from), to); } catch { return to; }
}

async function generateWireframesPortfolio(db, input, { exportDir }) {
  const { project_id, format = 'md', output_path, title = 'Wireframes Portfolio', include_tags } = input;
  const proj = db.prepare('SELECT root_path FROM projects WHERE id=?').get(project_id);
  if (!proj || !proj.root_path) throw new Error('Project root_path not set');
  const projectRoot = proj.root_path;
  // Collect wireframe documents
  let rows = db.prepare("SELECT path, tags, content, created_at FROM documents WHERE project_id=? AND (type='diagram' OR type='wireframe') ORDER BY created_at ASC").all(project_id);
  rows = rows.filter(r => {
    const tags = (r.tags || '').toLowerCase();
    const hasWireframe = tags.includes('wireframe');
    if (!hasWireframe) return false;
    if (include_tags && include_tags.length) {
      return include_tags.every(t => tags.includes(String(t).toLowerCase()));
    }
    return true;
  });
  const items = rows.map((r, i) => {
    const h1 = firstHeading(r.content || '') || `Wireframe ${i + 1}`;
    const img = detectImageForDoc(projectRoot, r.path);
    return { title: h1, docPath: r.path, image: img };
  });
  // Compose markdown
  const defaultOutBase = path.join(projectRoot, '_bmad-output', 'portfolio');
  const outPath = output_path || path.join(defaultOutBase, `wireframes.${format}`);
  ensureDir(path.dirname(outPath));
  const mdLines = [];
  mdLines.push(`# ${title}`);
  mdLines.push('');
  mdLines.push(`Generated: ${new Date().toISOString()}`);
  mdLines.push('');
  if (!items.length) mdLines.push('_No wireframes found. Use bmad.create_wireframe to add._');
  else {
    mdLines.push('## Table of Contents');
    for (const it of items) mdLines.push(`- [${it.title}](#${it.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$|/g,'')})`);
    mdLines.push('');
    for (const it of items) {
      mdLines.push(`## ${it.title}`);
      if (it.image) {
        const rel = relPath(outPath, it.image);
        mdLines.push('', `![${it.title}](${rel})`, '');
      } else {
        mdLines.push('', '_No image found next to wireframe doc; include a .png/.jpg/.svg export with the same basename._', '');
      }
    }
  }
  const markdown = mdLines.join('\n');
  if (format === 'md') {
    fs.writeFileSync(outPath, markdown, 'utf8');
    return { success: true, path: outPath, count: items.length };
  }
  if (format === 'html') {
    const html = renderMarkdownHtml(title, markdown);
    fs.writeFileSync(outPath, html, 'utf8');
    return { success: true, path: outPath, count: items.length };
  }
  if (format === 'pdf') {
    const html = renderMarkdownHtml(title, markdown);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir?.() || '/tmp', 'bmad-portfolio-'));
    const tmpHtml = path.join(tmpDir, 'wireframes.html');
    fs.writeFileSync(tmpHtml, html, 'utf8');
    try {
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.goto('file://' + tmpHtml, { waitUntil: 'networkidle0' });
      const waitMs = Number(process.env.BMAD_PDF_RENDER_WAIT_MS || 1200);
      await page.waitForTimeout(waitMs);
      await page.pdf({ path: outPath, format: 'A4', printBackground: true });
      await browser.close();
      return { success: true, path: outPath, count: items.length };
    } catch (e) {
      return { success: false, error: 'pdf-deps-missing', detail: 'Install puppeteer to enable PDF export', suggested_command: 'npm i puppeteer' };
    }
  }
  throw new Error('Unsupported format: ' + format);
}

module.exports.generateWireframesPortfolio = (db, input, ctx) => generateWireframesPortfolio(db, input, ctx);

// ---------- Phase Gates (Question Discipline) ----------
const DEFAULT_GATES = [
  { key: 'discovery_questions', label: 'Discovery clarifying questions answered' },
  { key: 'prd_clarifications', label: 'PRD clarifications addressed' },
  { key: 'ux_clarifications', label: 'UX clarifications addressed' },
  { key: 'nfr_questions', label: 'Non-functional requirements clarified' },
  { key: 'test_design_questions', label: 'Test design clarifications gathered' }
];

function ensureDefaultGates(db, project_id) {
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM phase_gates WHERE project_id=?').get(project_id).n;
  if (cnt > 0) return;
  const ins = db.prepare('INSERT OR IGNORE INTO phase_gates (project_id, gate_key, status, notes) VALUES (?,?,?,NULL)');
  for (const g of DEFAULT_GATES) ins.run(project_id, g.key, 'open');
}

function listPhaseGates(db, input) {
  const { project_id } = input;
  ensureDefaultGates(db, project_id);
  const rows = db.prepare('SELECT gate_key, status, COALESCE(notes, "") AS notes, updated_at FROM phase_gates WHERE project_id=? ORDER BY gate_key ASC').all(project_id);
  return { gates: rows };
}

function setPhaseGate(db, input) {
  const { project_id, gate_key, status, notes } = input;
  if (!project_id || !gate_key || !status) throw new Error('project_id, gate_key, status required');
  db.prepare(`INSERT INTO phase_gates (project_id, gate_key, status, notes)
              VALUES (?,?,?,?)
              ON CONFLICT(project_id, gate_key) DO UPDATE SET status=excluded.status, notes=COALESCE(excluded.notes, phase_gates.notes), updated_at=CURRENT_TIMESTAMP`)
    .run(project_id, gate_key, status, notes || null);
  return { success: true };
}

function recommendPhaseGates(db, input) {
  // Static recommendations for now; could be phase-aware later
  return { recommended: DEFAULT_GATES };
}

module.exports.listPhaseGates = listPhaseGates;
module.exports.setPhaseGate = setPhaseGate;
module.exports.recommendPhaseGates = recommendPhaseGates;
