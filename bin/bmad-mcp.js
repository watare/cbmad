#!/usr/bin/env node
/*
  BMAD MCP Server CLI
  Commands:
    - init: install server into ~/.config/bmad-server and create DB
    - schema: write MCP schema bundle to ~/.config/bmad-server/schemas/mcp.schema.json
    - project-init: scaffold bmad.config.yaml in current directory
    - project-scaffold: add Makefile template for project (bmad-init)
    - register-project [config]: register current project (reads bmad.config.yaml by default)
    - import <path>: guidance to import legacy BMAD project
    - doctor: show environment and config paths
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
let YAML = null;
try { YAML = require('yaml'); } catch { /* optional */ }

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function configRoot() {
  return path.join(os.homedir(), '.config', 'bmad-server');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFileSafe(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function writeIfMissing(dst, content) {
  ensureDir(path.dirname(dst));
  if (!fs.existsSync(dst)) fs.writeFileSync(dst, content);
}

function installServer() {
  const root = configRoot();
  ensureDir(root);
  ensureDir(path.join(root, 'db'));
  ensureDir(path.join(root, 'schemas'));
  ensureDir(path.join(root, 'exports'));

  const packageRoot = path.join(__dirname, '..');
  const serverSrc = path.join(packageRoot, 'src', 'server.js');
  const serverDst = path.join(root, 'server.js');
  copyFileSafe(serverSrc, serverDst);

  // Drop default schemas (placeholder)
  const schemaSrcDir = path.join(packageRoot, 'schemas');
  if (fs.existsSync(schemaSrcDir)) {
    for (const file of fs.readdirSync(schemaSrcDir)) {
      copyFileSafe(path.join(schemaSrcDir, file), path.join(root, 'schemas', file));
    }
  }

  // Create default DB if missing (server will migrate on first run)
  const dbPath = path.join(root, 'db', 'bmad.sqlite');
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, '');
  }

  const mcpConfigPath = path.join(os.homedir(), '.claude', 'mcp-servers.json');
  ensureDir(path.dirname(mcpConfigPath));
  let mcpConfig = {};
  if (fs.existsSync(mcpConfigPath)) {
    try { mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')); } catch {}
  }
  mcpConfig["bmad"] = {
    command: "node",
    args: [serverDst],
    env: {
      BMAD_DB_PATH: path.join(root, 'db', 'bmad.sqlite'),
      BMAD_LOG_LEVEL: 'info',
      BMAD_EXPORT_DIR: path.join(root, 'exports')
    }
  };
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  console.log('✔ BMAD MCP installé dans', root);
  console.log('✔ MCP déclaré dans', mcpConfigPath);
}

function cmdDoctor() {
  const root = configRoot();
  console.log('Config root:', root);
  console.log('Server:', path.join(root, 'server.js'));
  console.log('DB:', path.join(root, 'db', 'bmad.sqlite'));
  console.log('Exports:', path.join(root, 'exports'));
  console.log('Schemas:', path.join(root, 'schemas'));
}

function cmdImport(projectPath) {
  if (!projectPath) {
    console.error('Usage: bmad-mcp import /path/to/project');
    process.exit(2);
  }
  const root = configRoot();
  const serverPath = path.join(root, 'server.js');
  if (!fs.existsSync(serverPath)) {
    console.error('Erreur: serveur MCP non installé. Exécutez: bmad-mcp init');
    process.exit(1);
  }
  // Simple guidance – the actual import is done via MCP tool bmad.import_project
  console.log('Pour importer via MCP, lancez Claude et exécutez l’outil bmad.import_project');
  console.log('Paramètres conseillés:', JSON.stringify({ project_id: path.basename(projectPath), root_path: path.resolve(projectPath) }, null, 2));
}

function cmdSchema() {
  const root = configRoot();
  const out = path.join(root, 'schemas', 'mcp.schema.json');
  const bundle = require('../src/schema').asBundle();
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2));
  console.log('✔ MCP schema written to', out);
}

function cmdProjectInit(cwd) {
  const projectRoot = cwd || process.cwd();
  const projectId = path.basename(projectRoot);
  const cfgPath = path.join(projectRoot, 'bmad.config.yaml');
  const content = `project_id: ${projectId}\nname: ${projectId}\nroot_path: ${projectRoot}\nconfig:\n  user_name: your-name\n  user_skill_level: expert\n  communication_language: fr\n`;
  if (fs.existsSync(cfgPath)) {
    console.log('bmad.config.yaml existe déjà, aucune modification.');
    return;
  }
  fs.writeFileSync(cfgPath, content);
  // Prepare human-readable exports folder
  const outDir = path.join(projectRoot, '_bmad-output');
  ensureDir(path.join(outDir, 'stories'));
  ensureDir(path.join(outDir, 'planning'));
  ensureDir(path.join(outDir, 'logs'));
  console.log('✔ Créé', cfgPath);
  console.log('✔ Préparé', outDir);
  console.log('Astuce: en session, appelez bmad.register_project pour enregistrer ce projet.');
}

function cmdProjectScaffold(cwd) {
  const projectRoot = cwd || process.cwd();
  const src = path.join(__dirname, '..', 'templates', 'project', 'Makefile');
  const dst = path.join(projectRoot, 'Makefile');
  if (fs.existsSync(dst)) {
    console.log('Makefile already exists, not overwriting.');
    return;
  }
  fs.copyFileSync(src, dst);
  console.log('✔ Project Makefile created:', dst);
}

function cmdRegisterProject(cfgPath) {
  const { getDb, migrate } = require('../src/store/db');
  const tools = require('../src/tools');
  const root = configRoot();
  const dbPath = path.join(root, 'db', 'bmad.sqlite');
  const cwd = process.cwd();
  const file = cfgPath || path.join(cwd, 'bmad.config.yaml');
  if (!fs.existsSync(file)) {
    console.error('Config not found:', file);
    process.exit(1);
  }
  const raw = fs.readFileSync(file, 'utf8');
  let data = {};
  if (YAML && typeof YAML.parse === 'function') {
    data = YAML.parse(raw) || {};
  } else {
    // Minimal YAML parser for the expected structure
    data = {}; let inConfig = false;
    const cfg = {};
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const mTop = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
      const mCfg = line.match(/^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
      if (mTop) {
        const k = mTop[1]; const v = mTop[2];
        if (k === 'config') { inConfig = true; continue; }
        data[k] = v;
        inConfig = false;
      } else if (inConfig && mCfg) {
        cfg[mCfg[1]] = mCfg[2];
      }
    }
    if (Object.keys(cfg).length) data.config = cfg;
  }
  const id = data.project_id || path.basename(cwd);
  const name = data.name || id;
  const root_path = data.root_path || cwd;
  const config = data.config || {};
  const db = getDb(dbPath); migrate(db);
  const out = tools.registerProject(db, { id, name, root_path, config });
  console.log('✔ Registered project:', out.project_id);
}

const [,, cmd, arg1] = process.argv;
switch (cmd) {
  case 'init':
    installServer();
    break;
  case 'project-init':
    cmdProjectInit(process.cwd());
    break;
  case 'project-scaffold':
    cmdProjectScaffold(process.cwd());
    break;
  case 'import':
    cmdImport(arg1);
    break;
  case 'register-project':
    cmdRegisterProject(arg1);
    break;
  case 'doctor':
    cmdDoctor();
    break;
  case 'schema':
    cmdSchema();
    break;
  default:
    console.log('Usage: bmad-mcp <init|project-init|project-scaffold|register-project|import|doctor|schema>');
    process.exit(2);
}
