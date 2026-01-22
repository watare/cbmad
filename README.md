BMAD MCP Server

Résumé
- Serveur MCP Node.js centralisé (SQLite) pour exécuter la méthode BMAD sans recharger le framework dans le contexte du LLM.
- Expose des tools `bmad.*` (MCP) pour piloter tous les workflows (dev, review, planning, discovery, QA, versionning, etc.).
- Exports Markdown pour lecture humaine (non source de vérité), générés à la demande dans `project/_bmad-output/`.

Architecture
- Base de données: SQLite (fichier unique), accessible via better-sqlite3.
- Exports: Markdown générés à la demande ou après mutation, lecture humaine, non source de vérité.
- Installation: dans `~/.config/bmad-server/` (unique par utilisateur).
- LLM: interagit uniquement via tools MCP (pas de parsing de gros fichiers).

Chemins
- Serveur MCP: `~/.config/bmad-server/server.js`
- Base SQLite: `~/.config/bmad-server/db/bmad.sqlite`
- Exports: `~/.config/bmad-server/exports/`
- Config MCP (Claude): `~/.claude/mcp-servers.json`

Pré-requis / Conditions initiales
- Dépôt Git déjà initialisé dans chaque projet applicatif où vous utiliserez BMAD (ex. `git init && git add -A && git commit -m "init"`).
- Node.js >= 18 et npm installés localement.
- Accès en écriture à `~/.config` et `~/.claude` (créés au besoin).
- Optionnel: `~/.local/bin` présent dans le `PATH` pour le shim `bmad-mcp`.

Installation (1 commande)
- Dans ce repo: `npm install` puis `make install`
  - Installe le serveur MCP sous `~/.config/bmad-server`
  - Déclare le serveur `bmad` dans `~/.claude/mcp-servers.json`
  - Génère `~/.config/bmad-server/schemas/mcp.schema.json`
  - Crée un shim `~/.local/bin/bmad-mcp` (si présent)
  - Crée/complète `~/.claude/CLAUDE.md`
- Vérifier: `bmad-mcp doctor`

Installation globale (quand publié)
- `npm i -g @bmad/mcp-server`
- `bmad-mcp init`

Utilisation côté projet (CLI uniquement)
- Ajouter un fichier léger `bmad.config.yaml` au niveau racine du projet (identité, nom, chemin), par exemple:

  project_id: gridmv
  name: GridMV Power Analysis
  root_path: /home/ubuntu/gridmv
  config:
    user_name: alice
    user_skill_level: expert
    communication_language: fr

- En session Claude: utiliser les tools MCP exposés (ex: `bmad.register_project`, `bmad.get_next_story`, etc.).
- Les exports humains se trouvent dans `_bmad-output/` du projet si vous les demandez explicitement via `bmad.export_project_md` en définissant `output_dir` vers ce dossier.

Créer un nouveau projet (init rapide)
- Dans le dossier du projet:
  1) `bmad-mcp project-init` (écrit/écrase `bmad.config.yaml` avec backup `.bak-*`, prépare `_bmad-output/`)
  2) `bmad-mcp register-project` (idempotent; enregistre/actualise le projet dans la DB)
  3) Ouvrir Claude dans ce dossier et lancer vos workflows `/bmad...`

Où tourne le MCP ?
- En mode MCP, Claude lance le binaire configuré (ici `node ~/.config/bmad-server/server.js`) et communique via stdio.
- Pas de démon permanent nécessaire. Un seul serveur par utilisateur.

Stockage Git
- Recommmandé: versionner ce repo serveur dans un dépôt Git dédié (infrastructure BMAD).
- Dans les projets applicatifs: ne pas dupliquer le framework. Versionner uniquement `bmad.config.yaml` et, si souhaité, les exports `_bmad-output/` (en lecture seule, car non source de vérité).

Déploiement/Make
- Ce repo inclut un `Makefile` pour opérations courantes locales:
  - `make install-local` : copie dans `~/.config/bmad-server`
  - `make db-backup` : sauvegarde `bmad.sqlite` dans `~/.config/bmad-server/db/backup-YYYYMMDDHHMM.sqlite`
  - `make db-vacuum` : compaction de la base
  - `make uninstall` : supprime l’installation (non destructif pour la DB)

Mise à jour
- Après mise à jour du package/npm: `bmad-mcp init` re-copie `server.js` si nécessaire. Les migrations DB sont idempotentes (appliquées au démarrage du serveur).

Sécurité & Permissions
- Le serveur opère sur des chemins fournis par l’utilisateur (ex: `root_path`). Ils doivent être fiables (projets locaux).
- Les chemins sont résolus sans droits élevés; pas d’exécution de code externe.

Angles morts validés (principaux)
- Concurrence: `better-sqlite3` est synchrone, serveur MCP mono-process. OK pour usage local, non multi-process.
- Schéma versionné: migrations idempotentes incluses; prévoir versions futures (PRAGMA user_version si besoin).
- Import tolérant: le parseur Markdown est minimal; à renforcer pour des projets hétérogènes.
- Export volumineux: génération à la demande (outil `export_project_md`) pour éviter I/O non nécessaires.
- Windows: chemins `~` et `~/.config` supposent Unix-like. Ajouter support `%APPDATA%` si nécessaire.
- Validation: JSON Schema minimal via SDK; peut être étendu avec `jsonschema`.

Outils MCP implémentés (v0)
- Project: `bmad.register_project`, `bmad.get_project_context`
- Story: `bmad.get_next_story`, `bmad.get_story_context`, `bmad.get_story_summary`, `bmad.create_story`, `bmad.update_story_status`
- Tasks: `bmad.complete_task`, `bmad.add_review_tasks`
- Notes & Fichiers: `bmad.add_dev_note`, `bmad.register_files`, `bmad.add_changelog_entry`
- Planning: `bmad.get_planning_doc`, `bmad.update_planning_doc`
- Sprint: `bmad.get_sprint_status`, `bmad.log_action`
- Export: `bmad.export_story_md`, `bmad.export_project_md`
- Import: `bmad.import_project` (stub tolérant)
 - Compléments: `bmad.set_current_sprint`, `bmad.update_acceptance_criteria`, `bmad.list_stories`, `bmad.list_epics`, `bmad.update_epic`, `bmad.search_stories`
 - Review fix: `bmad.get_review_backlog`, `bmad.complete_review_item`, `bmad.bulk_complete_review`
 - Réservations: `bmad.reserve_task`, `bmad.release_task`, `bmad.get_reservations`
- PR: `bmad.generate_pr` (titre/corps), `bmad.export_pr_md`
 - Story admin: `bmad.update_story`, `bmad.delete_story`
 - Epic admin: `bmad.get_epic`, `bmad.delete_epic`
 - Labels: `bmad.set_story_labels`, `bmad.list_story_labels`, `bmad.search_by_label`
 - Split/Merge: `bmad.split_story`, `bmad.merge_stories`
 - Story sprint assign: `bmad.set_story_sprint`, `bmad.list_stories_by_sprint`
- Document discovery: `bmad.scan_documents`, `bmad.list_documents`, `bmad.get_document`, `bmad.search_documents`
 - Bugs/Quick fix: `bmad.create_bug`, `bmad.update_bug_status`, `bmad.get_bug`, `bmad.list_bugs`, `bmad.link_bug_files`, `bmad.link_bug_story`, `bmad.generate_bugfix_pr`
 - PRD versioning: `bmad.prd_new`, `bmad.get_prd_versions`, `bmad.switch_prd_version`

Schéma MCP (JSON Schema)
- Découverte via tool: `bmad.get_mcp_schema` (retourne le bundle inputs/outputs de tous les tools)
- Export local: `bmad-mcp schema` écrit `~/.config/bmad-server/schemas/mcp.schema.json`
- Usage: utile pour générer de la doc, valider des payloads, et outiller vos agents.

Variables d’environnement
- `BMAD_DB_PATH` (défaut: `~/.config/bmad-server/db/bmad.sqlite`)
- `BMAD_LOG_LEVEL` (info|silent, défaut: info)
- `BMAD_EXPORT_DIR` (défaut: `~/.config/bmad-server/exports`)

Maintenance
- Sauvegarde: `make db-backup` ou copie du fichier SQLite à froid.
- Nettoyage: `make db-vacuum` (VACUUM) périodique.
- Logs: table `logs` exportable en Markdown.

Intégration Claude (MCP)
Mettre à jour `~/.claude/mcp-servers.json` (fait par `bmad-mcp init`) :

{
  "bmad": {
    "command": "node",
    "args": ["~/.config/bmad-server/server.js"],
    "env": {
      "BMAD_DB_PATH": "~/.config/bmad-server/db/bmad.sqlite",
      "BMAD_LOG_LEVEL": "info"
    }
  }
}

Roadmap
- Parser d’import amélioré (planning/implementation-artifacts) + détection des doublons.
- Export automatique sur mutation (configurable).
- Multi-utilisateur (déport DB + auth) si besoin futur.
