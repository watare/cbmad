const Database = require('better-sqlite3');

function getDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  return db;
}

function migrate(db) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      config JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS epics (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'planned',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      epic_id TEXT REFERENCES epics(id),
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'draft',
      acceptance_criteria JSON,
      dev_notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, key)
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      description TEXT NOT NULL,
      done BOOLEAN DEFAULT FALSE,
      is_review_followup BOOLEAN DEFAULT FALSE,
      severity TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS story_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      entry TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      story_id TEXT REFERENCES stories(id),
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sprint_status (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      current_sprint TEXT,
      status_data JSON,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS planning_docs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS planning_doc_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL,
      version TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, type, version)
    )`,
    `CREATE TABLE IF NOT EXISTS story_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      title TEXT,
      description TEXT,
      status TEXT,
      acceptance_criteria JSON,
      dev_notes TEXT,
      tasks_snapshot JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(story_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      path TEXT NOT NULL,
      type TEXT,
      tags TEXT,
      content TEXT,
      summary TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, path)
    )`,
    `CREATE TABLE IF NOT EXISTS story_labels (
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      PRIMARY KEY(story_id, label)
    )`,
    `CREATE TABLE IF NOT EXISTS story_sprints (
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      sprint_label TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(story_id)
    )`,
    `CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      task_idx INTEGER NOT NULL,
      agent TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(story_id, task_idx)
    )`,
    `CREATE TABLE IF NOT EXISTS epic_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      epic_number INTEGER NOT NULL,
      version TEXT NOT NULL,
      title TEXT,
      description TEXT,
      status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, epic_number, version)
    )`,
    `CREATE TABLE IF NOT EXISTS epic_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      epic_number INTEGER NOT NULL,
      entry TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS review_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      reviewer TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS review_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      severity TEXT,
      description TEXT NOT NULL,
      file TEXT,
      line INTEGER,
      status TEXT NOT NULL DEFAULT 'open'
    )`,
    `CREATE TABLE IF NOT EXISTS test_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      story_id TEXT,
      title TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS test_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
      key TEXT,
      title TEXT NOT NULL,
      steps TEXT,
      expected TEXT,
      status TEXT DEFAULT 'unverified'
    )`,
    `CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(plan_id, run_id)
    )`,
    `CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS bugs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT,
      severity TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      story_id TEXT REFERENCES stories(id),
      introduced_in TEXT,
      fixed_in TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS bug_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bug_id TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_epics_project ON epics(project_id)` ,
    `CREATE INDEX IF NOT EXISTS idx_stories_project ON stories(project_id)` ,
    `CREATE INDEX IF NOT EXISTS idx_tasks_story ON tasks(story_id)`,
    `CREATE INDEX IF NOT EXISTS idx_res_project ON reservations(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_docs_project ON documents(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_epic_versions ON epic_versions(project_id, epic_number)` ,
    `CREATE INDEX IF NOT EXISTS idx_epic_changelog ON epic_changelog(project_id, epic_number)` ,
    `CREATE INDEX IF NOT EXISTS idx_review_findings_session ON review_findings(session_id)` ,
    `CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(project_id)`
  ];
  db.transaction(() => { stmts.forEach(sql => db.prepare(sql).run()); })();
}

module.exports = { getDb, migrate };
