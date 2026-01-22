## BMAD MCP Server

### Résumé
- Serveur MCP Node.js centralisé (SQLite) pour exécuter la méthode BMAD sans recharger le framework dans le contexte du LLM.
- Expose des tools `bmad.*` (MCP) pour piloter tous les workflows (dev, review, planning, discovery, QA, versionning, etc.).

## Quick Start

```bash
# 0) Pré‑requis: Node >= 18, repo Git initialisé dans votre projet

# 1) Installer le serveur MCP (dans ce repo)
npm install
make install                 # PDF désactivé par défaut
# Pour activer l'export PDF (installe puppeteer):
# make install PDF=1
bmad-mcp doctor

# 2) Bootstrap projet (1 commande, recommandé)
#    - project-init + register + install workflows BMAD-METHOD + update CLAUDE.md
bmad-mcp bootstrap

# 3) Ouvrir Claude dans le dossier du projet
#    Vérifier /mcp puis utiliser les tools `bmad.*` (ex: bmad.get_project_status)
```

## BMAD Classique vs BMAD via MCP

### BMAD Classique (BMAD-METHOD direct)
- Installe les workflows sous `{project-root}/_bmad/bmm/workflows/`.
- L’agent lit/charge des fichiers (MD/YAML) et garde du contexte en mémoire à chaque session.
- Les exports deviennent souvent la « source de vérité » (risque de divergence, coût tokens élevé).

### BMAD via MCP (ce repo)
- Source de vérité: SQLite (persisté), pas les exports MD.
- Claude interagit via des tools MCP (`bmad.*`) et ne charge que les sections nécessaires des workflows (via `bmad.open_workflow`/`bmad.next_step` ou MCP resources).
- Exports MD: générés à la demande pour humains, jamais requis pour décisions.
- Démarrage rapide: `bmad-mcp bootstrap` (init projet + enregistrement + installation workflows + mise à jour CLAUDE.md).

### Outils « Runner BMAD » intégrés
- `bmad.install_bmad_method`: installe/actualise BMAD‑METHOD dans le projet (ou global).
- `bmad.list_workflows`: lit `module-help.csv` et expose la liste/codes (p. ex. `bmad:bmm:create-prd`).
- `bmad.list_optional_workflows`: filtre les workflows optionnels (colonne required=false dans `module-help.csv`).
- `bmad.open_workflow`: charge un workflow par code et renvoie son contenu.
- `bmad.next_step`: renvoie l’étape suivante (splitter simple par `##`), pour guider l’agent étape par étape.
- `bmad.generate_workflow_mapping`: génère une table de correspondance « codes → appels runner ».

### Similarités
- Phases et workflows BMAD inchangés (Discovery → Planning → Solutioning → Implementation), mêmes artefacts (PRD/Architecture/UX/Epics/Stories/Tests/Reviews).
- Les mêmes codes de workflow (ex: `bmad:bmm:create-prd`) — accessibles via `bmad.list_workflows`/`bmad.open_workflow`.
- Rôles/agents (PM/Architect/Dev/TEA/UX) respectés via des prompts et le séquenceur d’étapes.

### Différences
- État persistant en DB (pas de relecture massive de fichiers à chaque session).
- Étapes chargées finement (niveau « step »), pas tout le workflow en bloc.
- Sécurité multi‑agents (réservations, préconditions `updated_at`).
- Outils composés (ex: `bmad.get_project_status`, `bmad.workflow_init`).

## Appel & Séquençage des Workflows (précis)

### Références de fichiers (exemples réels)
- PRD: `_bmad/bmm/workflows/2-plan-workflows/prd/workflow.md`
  - Étapes associées: `_bmad/bmm/workflows/2-plan-workflows/prd/steps-e/*` (écriture) et `steps-v/*` (validation).
- Product Brief: `_bmad/bmm/workflows/1-analysis/create-product-brief/workflow.md`
  - Étapes associées: `_bmad/bmm/workflows/1-analysis/create-product-brief/steps/*`.

Ces chemins sont identiques entre la méthode classique et l’installation via `bmad-mcp bootstrap` (le répertoire `_bmad/bmm` est copié dans le projet). Côté MCP, les mêmes fichiers peuvent aussi être installés globalement sous `~/.config/bmad-server/bmm/workflows`.

### Appel du workflow — Classique
- Invocation: l’agent/équipe utilise le code (ex: `bmad:bmm:create-prd`) pour repérer le fichier, puis ouvre directement le Markdown: `project/_bmad/bmm/workflows/2-plan-workflows/prd/workflow.md`.
- Séquençage: lecture humaine du fichier `workflow.md`, puis navigation vers les sous‑étapes référencées (fichiers `steps-*`). L’agent passe d’une étape à l’autre manuellement.
- Écriture: les livrables (PRD, Architecture, UX, etc.) sont rédigés/édités dans des fichiers Markdown de projet (ex: `docs/PRD.md`), ou dans des exports qui deviennent la source de vérité.
- Lecture/état: le LLM relit de larges pans de fichiers (workflows + artefacts) à chaque session pour obtenir le contexte et déterminer la prochaine action.

### Appel du workflow — MCP (ce serveur)
- Invocation: `bmad.list_workflows` lit `module-help.csv` et expose les codes officiels. `bmad.open_workflow({ code })` charge le fichier `workflow.md` correspondant, en résolvant le chemin projet (`project/_bmad/bmm/workflows/...`) ou global (`~/.config/bmad-server/bmm/workflows/...`).
- Séquençage: `bmad.next_step({ code, cursor })` découpe le contenu du `workflow.md` en sections de niveau `##` et renvoie l’étape demandée. L’agent pilote l’index `cursor` pour avancer étape‑par‑étape.
  - Note: le découpage est volontairement simple (split sur `##`). Il sera affiné pour tirer parti des sous‑fichiers `steps-*` quand présents.
- Écriture: les livrables sont persistés via des appels get/set en base:
  - PRD/Architecture/UX: `bmad.get_planning_doc` / `bmad.update_planning_doc` (avec `precondition_updated_at` pour éviter les conflits).
  - Stories/Epics: `bmad.create_story`/`bmad.update_story`/`bmad.update_epic`, versions via `*_version(s)` et snapshots.
  - Sprint/Readiness/Reviews: outils dédiés (`bmad.set_current_sprint`, `bmad.start_readiness`, `bmad.start_review`, etc.).
- Lecture/état: l’agent récupère uniquement l’état structuré nécessaire (JSON) au moment opportun. Les exports Markdown sont optionnels et non sources de vérité.

### Écriture dans fichiers vs get/set (résumé opérationnel)
- Classique:
  - Source de vérité: fichiers du repo (`.md`, `.yaml`) modifiés directement par l’agent/humain.
  - Flux I/O: beaucoup de relectures/écritures de documents volumineux par le LLM.
  - Séquençage: implicite, piloté par l’humain via la lecture des pas du workflow.
- MCP:
  - Source de vérité: SQLite (tables `planning_docs`, `epics`, `stories`, `sprint_status`, etc.).
  - Flux I/O: API outillées `bmad.*` qui renvoient/persistents des objets compacts (get/set), et chargent le workflow en pas courts.
  - Séquençage: explicite via `cursor` dans `bmad.next_step`, et actions outillées corrélées à chaque pas.

## Parcours De Bout En Bout

### BMAD Classique (résumé)
```bash
# 1) Installer BMAD-METHOD dans le projet
git clone https://github.com/bmad-code-org/BMAD-METHOD
cp -R BMAD-METHOD/src/bmm {project}/_bmad/

# 2) Dans Claude
# - Ouvrir un workflow (ex: bmad:bmm:create-prd) et suivre les étapes MD/YAML
# - Sauvegarder les artefacts dans des fichiers MD (+ exports)
```

### BMAD via MCP (ce repo)
```bash
# 0) Installer le serveur MCP (dans ce repo)
npm install
make install

# 1) Dans le projet
bmad-mcp bootstrap   # project-init + register + workflows + CLAUDE.md

# 2) Dans Claude
// Découverte / statut global
bmad.get_project_status({ project_id: "my-app" })

// Lister les workflows et ouvrir le PRD
bmad.list_workflows({ project_id: "my-app" })
bmad.open_workflow({ project_id: "my-app", code: "bmad:bmm:create-prd" })
bmad.next_step({ project_id: "my-app", code: "bmad:bmm:create-prd", cursor: 0 })

// Persister les artefacts (exemples planning docs)
bmad.update_planning_doc({ project_id: "my-app", type: "prd", content: "...", generate_summary: true })
bmad.update_planning_doc({ project_id: "my-app", type: "architecture", content: "...", precondition_updated_at: "<from last fetch>" })

// Runner mapping (rapide)
bmad.generate_workflow_mapping({ project_id: "my-app" })
```

## Flux Canonique Phase‑par‑Phase

Les deux approches respectent la séquence BMAD: Discovery → Planning → Solutioning → Implementation. Ci‑dessous, les actions typiques et leurs équivalents.

### Discovery
- Classique:
  - Parcourir la base documentaire localement, copier/coller dans le contexte, prendre des notes.
  - Démarrer « generate‑project‑context » ou autres workflows d’idéation.
- MCP:
  - `bmad.scan_documents` pour indexer les docs du dépôt (résumés + recherche).
  - `bmad.start_research_session` → `bmad.add_research_note` → `bmad.list_research_notes`.
  - `bmad.list_workflows` → `bmad.open_workflow` sur « generate‑project‑context »; avancer avec `bmad.next_step`.

### Planning (PRD/Architecture/UX)
- Classique:
  - Ouvrir `bmad:bmm:create-prd` puis éditer le PRD en Markdown.
  - Architecture/UX rédigés en fichiers MD.
- MCP:
  - `bmad.open_workflow` + `bmad.next_step` pour guider la création du PRD.
  - `bmad.update_planning_doc` pour persister: `type: prd | architecture | ux` avec `precondition_updated_at` (optimistic locking).
  - Versioning PRD: `bmad.prd_new`, `bmad.get_prd_versions`, `bmad.switch_prd_version` (idem génériques: `docNewVersion/switchDocVersion`).
  - UX review: `bmad.start_ux_review`, `bmad.approve_ux_review`/`bmad.reject_ux_review`, `bmad.list_ux_reviews`.
  - Étapes optionnelles: Product Brief (synthèse) et autres artefacts facultatifs.
    - Fichier workflow (classic): `_bmad/bmm/workflows/1-analysis/create-product-brief/workflow.md`.
    - Persistance MCP: `bmad.update_planning_doc({ type: 'product_brief' })`.
    - Versioning MCP: `bmad.product_brief_new`, `bmad.get_product_brief_versions`, `bmad.switch_product_brief_version`.
  - Autres optionnels (mappés):
    - NFR assess: `bmad.nfr_new` / `bmad.get_nfr_versions` / `bmad.switch_nfr_version` (type `nfr`).
    - Test Design: `bmad.test_design_new` / `bmad.get_test_design_versions` / `bmad.switch_test_design_version` (type `test_design`).
    - ATDD checklist: `bmad.atdd_new` / `bmad.get_atdd_versions` / `bmad.switch_atdd_version` (type `atdd`).
    - Traceability: `bmad.trace_new` / `bmad.get_trace_versions` / `bmad.switch_trace_version` (type `traceability`).
    - CI plan: `bmad.ci_plan_new` / `bmad.get_ci_plan_versions` / `bmad.switch_ci_plan_version` (type `ci_plan`).
    - Tech Spec (quick spec): `bmad.tech_spec_new` / `bmad.get_tech_spec_versions` / `bmad.switch_tech_spec_version` (type `tech_spec`).

### Solutioning (Epics/Stories/Readiness)
- Classique:
  - Rédiger Epics/Stories dans des fichiers, puis les faire évoluer.
  - Check‑lists de préparation éparses.
- MCP:
  - Epics: `bmad.update_epic`, versions: `bmad.epic_new_version`/`bmad.get_epic_versions`/`bmad.switch_epic_version`.
  - Stories: `bmad.create_story`, `bmad.update_story`, `bmad.story_snapshot` (versions), labels, split/merge, sprint assign.
  - Readiness: `bmad.start_readiness` → `bmad.update_readiness_item` → `bmad.finalize_readiness`.

### Implementation (Dev/Review/Sprint)
- Classique:
  - Suivre le workflow dev‐story/code‑review; état porté par le texte et l’interface Git.
- MCP:
  - Conduite des stories: `bmad.get_next_story`, `bmad.get_story_context`, tâches `bmad.complete_task`, notes `bmad.add_dev_note`, fichiers `bmad.register_files`.
  - Réservations multi‑agents: `bmad.reserve_task`/`bmad.release_task`/`bmad.get_reservations`.
  - Revue: `bmad.start_review`, `bmad.add_review_finding`, `bmad.close_review`, suivi `bmad.get_review_backlog` + rattrapage via `bmad.add_review_tasks`/`bmad.complete_review_item`/`bmad.bulk_complete_review`.
  - Sprint: `bmad.set_current_sprint`, `bmad.get_sprint_status`, génération plan: `bmad.sprint_planning_generate`.
  - Export humain: `bmad.export_story_md`, `bmad.generate_pr` + `bmad.export_pr_md`, `bmad.export_project_md`.
  - Docs export (MD/HTML/PDF): `bmad.export_planning_doc({ project_id, type, format:'md|html|pdf' })`, `bmad.export_docs({ project_id, types?, formats? })`.
    - PDF dépendances: exécuter `make install PDF=1` (installe puppeteer), sinon utilisez MD/HTML.

### Orchestration et bootstrap
- Classique: scripts manuels, prompts ad‑hoc, relecture de beaucoup de contexte.
- MCP:
  - Bootstrap 1‑commande: `bmad-mcp bootstrap` (installe workflows et met à jour CLAUDE.md avec rôles/règles de phase; prompts PM/Architect/Dev/TEA/UX inclus).
  - Statut composite: `bmad.get_project_status` (auto‑register au besoin) donne contexte+sprint+discovery+flags planning.
  - Initialisation orchestrée: `bmad.workflow_init` (register → sprint → docs → seed PRD/Arch/UX) puis renvoie le statut.
  - Proposer les étapes optionnelles: `bmad.list_optional_workflows` pour la phase en cours; conserver leurs livrables via `bmad.save_workflow_output` (stocké en DB + exportable).

## Gains en Tokens (ordre de grandeur)
- Classique (observé):
  - Chargement initial (workflows principaux + contexte projet): 15k–25k tokens.
  - Itération par phase (notes + artefacts ré‑ouverts): 10k–20k tokens.
  - Total session typique: 25k–40k tokens.
- MCP (observé):
  - Statut projet (JSON condensé): 0.2k–0.6k tokens.
  - Étape de workflow (une section): 0.3k–0.9k tokens.
  - Artefact (doc planning en DB): 0.5k–1.5k tokens.
  - Total session typique: 2k–5k tokens.
- Économie: ~70–95% selon la taille des workflows et des artefacts. Plus les projets grossissent, plus le gain se rapproche de 90%+.
- Pourquoi: chargement parcimonieux (step‑by‑step), state centralisé (DB), exports uniquement « à la demande ».

### Comparatif Tokens détaillé (pas à pas)
- Découverte des workflows:
  - Classique: exploration arbre + lecture manuelle d’indexes (0.5k–2k tokens selon volume).
  - MCP: `bmad.list_workflows` (0.1k–0.4k tokens) → JSON structuré uniquement.
- Ouverture d’un workflow PRD:
  - Classique: lecture complète de `workflow.md` (+ parfois `steps-*`) → 2k–6k tokens.
  - MCP: `bmad.next_step(cursor)` renvoie uniquement la section courante → 0.3k–0.9k tokens.
- Rédaction PRD (mise à jour incrémentale):
  - Classique: relecture du PRD MD pour contexte + insertion/édition → 1.5k–4k tokens par itération.
  - MCP: `bmad.get_planning_doc` (summary ou full) 0.3k–1.2k + `bmad.update_planning_doc` (payload compact) 0.1k–0.3k.
- Conduite d’une story (contexte + prochaine tâche):
  - Classique: relire story.md + tâches + notes → 1k–3k tokens.
  - MCP: `bmad.get_story_context` (JSON) 0.2k–0.6k + `bmad.complete_task` 0.1k–0.2k.
- Revue/retour (follow‑ups):
  - Classique: relecture de la section review + checklists → 0.8k–2k tokens.
  - MCP: `bmad.get_review_backlog` 0.2k–0.5k + `bmad.add_review_tasks`/`bmad.bulk_complete_review` 0.1k–0.3k.

### Profils de session (ordre de grandeur)
- Démarrage à froid (Classic vs MCP): 25k–40k vs 2k–5k.
- Itération courte (une étape de workflow + un artefact): 2k–7k vs 0.5k–2.5k.
- Sprint quotidien (plusieurs stories): 15k–30k vs 3k–10k.

### Méthode de validation interne (pratique)
- Utiliser des tailles d’objets renvoyés par `bmad.*` comme proxy des tokens (≈ 4 chars/token), comparer aux tailles des fichiers Markdown chargés en mode classique.
- Stratégie: tracer côté agent la longueur (caractères) des contenus chargés par étape; viser 70–95% de réduction sur les phases volumineuses (PRD/Architecture/Review).

### Architecture
- Base de données: SQLite (fichier unique), accessible via better-sqlite3.
- Exports: Markdown générés à la demande ou après mutation, lecture humaine, non source de vérité.
- Installation: dans `~/.config/bmad-server/` (unique par utilisateur).
- LLM: interagit uniquement via tools MCP (pas de parsing de gros fichiers).

### Chemins utiles
- Serveur MCP: `~/.config/bmad-server/server.js`
- Base SQLite: `~/.config/bmad-server/db/bmad.sqlite`
- Exports: `~/.config/bmad-server/exports/`
- Config MCP (Claude): `~/.claude/mcp-servers.json`

### Pré-requis / Conditions initiales
- Dépôt Git déjà initialisé dans chaque projet applicatif où vous utiliserez BMAD (ex. `git init && git add -A && git commit -m "init"`).
- Node.js >= 18 et npm installés localement.
- Accès en écriture à `~/.config` et `~/.claude` (créés au besoin).
- Optionnel: `~/.local/bin` présent dans le `PATH` pour le shim `bmad-mcp`.

### Installation (1 commande)
```bash
# Depuis ce repo
npm install
make install

# Vérification
bmad-mcp doctor
```

### Installation globale (quand publié)
- `npm i -g @bmad/mcp-server`
- `bmad-mcp init`

### Utilisation côté projet (CLI uniquement)
- Ajouter un fichier léger `bmad.config.yaml` au niveau racine du projet (identité, nom, chemin), par exemple:

```yaml
project_id: gridmv
name: GridMV Power Analysis
root_path: /home/ubuntu/gridmv
config:
  user_name: alice
  user_skill_level: expert
  communication_language: fr
```

- En session Claude: utiliser les tools MCP exposés (ex: `bmad.register_project`, `bmad.get_next_story`, etc.).
- Les exports humains se trouvent dans `_bmad-output/` du projet si vous les demandez explicitement via `bmad.export_project_md` en définissant `output_dir` vers ce dossier.

### Initialiser un projet (CLI)

```bash
# 1) Crée/écrase bmad.config.yaml (backup .bak-*) et prépare _bmad-output/
bmad-mcp project-init

# 2) Enregistre le projet dans la DB (idempotent)
bmad-mcp register-project

# 3) Ouvrir Claude dans ce dossier, puis utiliser vos /bmad...
```

### Où tourne le MCP ?
- En mode MCP, Claude lance le binaire configuré (ici `node ~/.config/bmad-server/server.js`) et communique via stdio.
- Pas de démon permanent nécessaire. Un seul serveur par utilisateur.

### Stockage Git
- Recommmandé: versionner ce repo serveur dans un dépôt Git dédié (infrastructure BMAD).
- Dans les projets applicatifs: ne pas dupliquer le framework. Versionner uniquement `bmad.config.yaml` et, si souhaité, les exports `_bmad-output/` (en lecture seule, car non source de vérité).

### Déploiement/Make
- Ce repo inclut un `Makefile` pour opérations courantes locales:
  - `make install-local` : copie dans `~/.config/bmad-server`
  - `make db-backup` : sauvegarde `bmad.sqlite` dans `~/.config/bmad-server/db/backup-YYYYMMDDHHMM.sqlite`
  - `make db-vacuum` : compaction de la base
  - `make uninstall` : supprime l’installation (non destructif pour la DB)

### Mise à jour
- Après mise à jour du package/npm: `bmad-mcp init` re-copie `server.js` si nécessaire. Les migrations DB sont idempotentes (appliquées au démarrage du serveur).

### Sécurité & Permissions
- Le serveur opère sur des chemins fournis par l’utilisateur (ex: `root_path`). Ils doivent être fiables (projets locaux).
- Les chemins sont résolus sans droits élevés; pas d’exécution de code externe.

### Angles morts validés (principaux)
- Concurrence: `better-sqlite3` est synchrone, serveur MCP mono-process. OK pour usage local, non multi-process.
- Schéma versionné: migrations idempotentes incluses; prévoir versions futures (PRAGMA user_version si besoin).
- Import tolérant: le parseur Markdown est minimal; à renforcer pour des projets hétérogènes.
- Export volumineux: génération à la demande (outil `export_project_md`) pour éviter I/O non nécessaires.
- Windows: chemins `~` et `~/.config` supposent Unix-like. Ajouter support `%APPDATA%` si nécessaire.
- Validation: JSON Schema minimal via SDK; peut être étendu avec `jsonschema`.

### Outils MCP implémentés
- Project: `bmad.register_project`, `bmad.get_project_context`, `bmad.get_project_status`, `bmad.workflow_init`
- Runner BMAD: `bmad.install_bmad_method`, `bmad.list_workflows`, `bmad.open_workflow`, `bmad.next_step`, `bmad.generate_workflow_mapping`
  - Optionnels: `bmad.list_optional_workflows`, `bmad.save_workflow_output`
  - Optional docs versioning: `bmad.product_brief_new`, `bmad.get_product_brief_versions`, `bmad.switch_product_brief_version`, `bmad.nfr_new`, `bmad.get_nfr_versions`, `bmad.switch_nfr_version`, `bmad.test_design_new`, `bmad.get_test_design_versions`, `bmad.switch_test_design_version`, `bmad.atdd_new`, `bmad.get_atdd_versions`, `bmad.switch_atdd_version`, `bmad.trace_new`, `bmad.get_trace_versions`, `bmad.switch_trace_version`, `bmad.ci_plan_new`, `bmad.get_ci_plan_versions`, `bmad.switch_ci_plan_version`, `bmad.tech_spec_new`, `bmad.get_tech_spec_versions`, `bmad.switch_tech_spec_version`.
- Story: `bmad.get_next_story`, `bmad.get_story_context`, `bmad.get_story_summary`, `bmad.create_story`, `bmad.update_story_status`, `bmad.update_story`, `bmad.delete_story`, `bmad.story_snapshot`, `bmad.get_story_versions`, `bmad.switch_story_version`
- Tasks: `bmad.complete_task`, `bmad.add_review_tasks`
- Notes & Fichiers: `bmad.add_dev_note`, `bmad.register_files`, `bmad.add_changelog_entry`
- Planning: `bmad.get_planning_doc`, `bmad.update_planning_doc`, `bmad.docNewVersion`, `bmad.getDocVersions`, `bmad.switchDocVersion`, `bmad.prd_new`, `bmad.get_prd_versions`, `bmad.switch_prd_version`, `bmad.product_brief_new`, `bmad.get_product_brief_versions`, `bmad.switch_product_brief_version`
- Sprint: `bmad.get_sprint_status`, `bmad.log_action`, `bmad.set_current_sprint`, `bmad.sprint_planning_generate`
- Export: `bmad.export_story_md`, `bmad.export_project_md`, `bmad.generate_pr`, `bmad.export_pr_md`
  - Docs export: `bmad.export_planning_doc` (single doc to md/html/pdf), `bmad.export_docs` (batch export)
- Import: `bmad.import_project`
- Review: `bmad.start_review`, `bmad.add_review_finding`, `bmad.close_review`, `bmad.get_review_backlog`, `bmad.complete_review_item`, `bmad.bulk_complete_review`
- Réservations: `bmad.reserve_task`, `bmad.release_task`, `bmad.get_reservations`
- Epics: `bmad.get_epic`, `bmad.update_epic`, `bmad.delete_epic`, `bmad.epic_new_version`, `bmad.get_epic_versions`, `bmad.switch_epic_version`, `bmad.add_epic_changelog`, `bmad.get_epic_changelog`
- Labels: `bmad.set_story_labels`, `bmad.list_story_labels`, `bmad.search_by_label`
- Story sprint assign: `bmad.set_story_sprint`, `bmad.list_stories_by_sprint`
- Document discovery: `bmad.scan_documents`, `bmad.list_documents`, `bmad.get_document`, `bmad.search_documents`
- Research/Ideas: `bmad.start_research_session`, `bmad.add_research_note`, `bmad.list_research_notes`, `bmad.add_idea`, `bmad.list_ideas`
- UX: `bmad.start_ux_review`, `bmad.approve_ux_review`, `bmad.reject_ux_review`, `bmad.list_ux_reviews`
- Readiness: `bmad.start_readiness`, `bmad.update_readiness_item`, `bmad.get_readiness_status`, `bmad.finalize_readiness`
- Components: `bmad.register_component`, `bmad.list_components`, `bmad.export_component`, `bmad.commit_component`
- Diagrams: `bmad.create_dataflow`, `bmad.create_diagram`, `bmad.create_flowchart`, `bmad.create_wireframe`

### Schéma MCP (JSON Schema)
- Découverte via tool: `bmad.get_mcp_schema` (retourne le bundle inputs/outputs de tous les tools)
- Export local: `bmad-mcp schema` écrit `~/.config/bmad-server/schemas/mcp.schema.json`
- Usage: utile pour générer de la doc, valider des payloads, et outiller vos agents.

### Variables d’environnement
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
 - Runner parsing avancé (détection de frontières d’étapes en YAML/MD, suggestions d’actions par étape).
 - Étendre les préconditions d’update (optimistic concurrency) aux entités restantes.
 - Option de pin « ref » pour `bmad.install_bmad_method` (tag/branch BMAD‑METHOD).

## Quick‑Reference: Mapping Workflows → Fichiers → Appels MCP

- Code: `bmad:bmm:create-prd` — Fichier: `_bmad/bmm/workflows/2-plan-workflows/prd/workflow.md` — Classic: ouvrir ce fichier + consulter `steps-e/*`, `steps-v/*` — MCP: `bmad.open_workflow({ project_id, code })`, `bmad.next_step({ project_id, code, cursor })`
- Code: `bmad:bmm:create-product-brief` — Fichier: `_bmad/bmm/workflows/1-analysis/create-product-brief/workflow.md` — Classic: ouvrir + naviguer `steps/*` — MCP: `bmad.open_workflow`, `bmad.next_step`
- Code: `bmad:bmm:dev-story` — Fichier: `_bmad/bmm/workflows/4-implementation/dev-story/workflow.yaml` — Classic: ouvrir YAML et suivre sections — MCP: `bmad.open_workflow` (YAML), `bmad.next_step` (pour YAML agit en bloc; parsing fin à venir)
- Code: `bmad:bmm:code-review` — Fichier: `_bmad/bmm/workflows/4-implementation/code-review/workflow.yaml` — Classic: ouvrir YAML — MCP: `bmad.open_workflow` (YAML), suivi via outils review (`bmad.start_review`, `bmad.add_review_finding`, etc.)
- Code: `bmad:bmm:sprint-planning` — Fichier: `_bmad/bmm/workflows/4-implementation/sprint-planning/workflow.yaml` — Classic: ouvrir YAML — MCP: `bmad.open_workflow`, actions via `bmad.sprint_planning_generate`, `bmad.get_sprint_status`
- Code: `bmad:bmm:workflow-status` — Fichier: `_bmad/bmm/workflows/workflow-status/workflow.yaml` — Classic: ouvrir YAML — MCP: `bmad.open_workflow`, statut via `bmad.get_project_status`

Note: Le mapping complet est disponible dynamiquement via `bmad.generate_workflow_mapping({ project_id })` (données issues de `module-help.csv`). Les workflows peuvent aussi être parcourus via les ressources MCP (`resources/list` sur `bmad://workflows`, `resources/read`).
### Importer un projet existant (MCP)
- Outil: `bmad.import_project({ project_id, root_path })`
- Ce que l’import tente automatiquement:
  - Stories: `_bmad-output/stories/*.md`, `_bmad-output/implementation-artifacts/*.md` (H1 "KEY — Title", sections "## Acceptance Criteria", "## Tasks").
  - Epics: `_bmad-output/planning/epics.md` ou `_bmad-output/planning-artifacts/epics.md` (lignes "- Epic N: Title").
  - Planning docs: recherche multi-chemins pour `prd|architecture|ux|product_brief|nfr|test_design|atdd|traceability|ci_plan|tech_spec`:
    - `_bmad-output/planning/<type>.md`, `_bmad-output/planning-artifacts/<type>.md`, `docs/<name>.md`, `<repo-root>/<name>.md`.
  - Logs: `_bmad-output/logs/logs.md`.
- Idempotence: l’import crée l’entrée `projects` si manquante et évite les doublons évidents.
- Après import: consultez `bmad.get_project_status` pour voir `planning_flags` et `counts` mis à jour.
- Exporter un document (MD/HTML/PDF)
  - Unitaire: `bmad.export_planning_doc({ project_id, type: 'prd', format: 'pdf' })`
  - Batch: `bmad.export_docs({ project_id, types: ['prd','architecture','ux'], formats: ['md','pdf'] })`
  - Rendu Formules/Diagrammes: export HTML embarque MathJax et Mermaid; PDF nécessite `puppeteer` installé côté serveur MCP.
