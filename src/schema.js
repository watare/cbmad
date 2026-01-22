// Centralized MCP tool schema (inputs and outputs)

const tools = [
  {
    name: 'bmad.register_project',
    description: 'Register or update a BMAD project',
    inputSchema: {
      type: 'object', required: ['id', 'name', 'root_path'], properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        root_path: { type: 'string' },
        config: { type: 'object', additionalProperties: true }
      }
    },
    outputSchema: {
      type: 'object', required: ['success', 'project_id'], properties: {
        success: { type: 'boolean' },
        project_id: { type: 'string' }
      }
    }
  },
  {
    name: 'bmad.get_project_context',
    description: 'Get project summary context',
    inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } } },
    outputSchema: {
      type: 'object', required: ['project', 'stats', 'recent_activity'], properties: {
        project: {
          type: 'object', required: ['id', 'name'], properties: {
            id: { type: 'string' }, name: { type: 'string' }, config: { type: ['object', 'null'] }
          }
        },
        stats: {
          type: 'object', required: ['total_epics', 'total_stories', 'stories_by_status'], properties: {
            total_epics: { type: 'number' }, total_stories: { type: 'number' },
            stories_by_status: { type: 'object', additionalProperties: { type: 'number' } },
            current_sprint: { type: ['string', 'null'] }
          }
        },
        recent_activity: { type: 'array', items: {
          type: 'object', required: ['type', 'timestamp'], properties: {
            type: { type: 'string' }, story_key: { type: ['string', 'null'] }, timestamp: { type: 'string' }
          }
        }}
      }
    }
  },
  {
    name: 'bmad.get_next_story',
    description: 'Get the next story to develop',
    inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' }, status_filter: { enum: ['ready-for-dev', 'in-progress'] } } },
    outputSchema: {
      type: 'object', required: ['found'], properties: {
        found: { type: 'boolean' },
        story: { type: 'object', required: ['id','key','title','status','epic','pending_tasks_count'], properties: {
          id: { type: 'string' }, key: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' },
          epic: { type: 'object', required: ['number','title'], properties: { number: { type: 'number' }, title: { type: 'string' } } },
          pending_tasks_count: { type: 'number' }
        }}
      }
    }
  },
  {
    name: 'bmad.get_story_context',
    description: 'Get full story context',
    inputSchema: { type: 'object', required: ['story_id'], properties: { story_id: { type: 'string' }, include: { type: 'array', items: { enum: ['tasks','acceptance_criteria','dev_notes','files','changelog'] } } } },
    outputSchema: {
      type: 'object', required: ['story','acceptance_criteria','tasks','dev_notes','files_changed','changelog'], properties: {
        story: { type: 'object', required: ['id','key','title','status','epic'], properties: {
          id: { type: 'string' }, key: { type: 'string' }, title: { type: 'string' }, description: { type: ['string','null'] }, status: { type: 'string' },
          epic: { type: 'object', required: ['number','title'], properties: { number: { type: 'number' }, title: { type: 'string' } } }
        }},
        acceptance_criteria: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, met: { type: 'boolean' } }, additionalProperties: true } },
        tasks: { type: 'array', items: { type: 'object', required: ['idx','description','done','is_review_followup'], properties: {
          idx: { type: 'number' }, description: { type: 'string' }, done: { type: 'boolean' }, is_review_followup: { type: 'boolean' }, severity: { type: ['string','null'] },
          subtasks: { type: 'array', items: { type: 'object', required: ['idx','description','done'], properties: { idx: { type: 'number' }, description: { type: 'string' }, done: { type: 'boolean' } } } }
        } } },
        dev_notes: { type: 'string' },
        files_changed: { type: 'array', items: { type: 'object', required: ['path','change_type'], properties: { path: { type: 'string' }, change_type: { type: 'string' } } } },
        changelog: { type: 'array', items: { type: 'object', required: ['entry','timestamp'], properties: { entry: { type: 'string' }, timestamp: { type: 'string' } } } },
        review: { type: ['object','null'] }
      }
    }
  },
  {
    name: 'bmad.get_story_summary',
    description: 'Get condensed story summary',
    inputSchema: { type: 'object', required: ['story_id'], properties: { story_id: { type: 'string' } } },
    outputSchema: {
      type: 'object', required: ['key','title','status','progress','blockers'], properties: {
        key: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' },
        current_task: { type: ['object','null'], properties: { idx: { type: 'number' }, description: { type: 'string' } } },
        progress: { type: 'object', required: ['done','total'], properties: { done: { type: 'number' }, total: { type: 'number' } } },
        blockers: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'bmad.create_story',
    description: 'Create a new story',
    inputSchema: { type: 'object', required: ['project_id','epic_number','key','title','acceptance_criteria','tasks'], properties: {
      project_id: { type: 'string' }, epic_number: { type: 'number' }, key: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      acceptance_criteria: { type: 'array', items: { type: 'string' } }, tasks: { type: 'array', items: { type: 'object', required: ['description'], properties: { description: { type: 'string' }, subtasks: { type: 'array', items: { type: 'string' } } } } },
      dev_notes: { type: 'string' }
    } },
    outputSchema: { type: 'object', required: ['success','story_id'], properties: { success: { type: 'boolean' }, story_id: { type: 'string' } } }
  },
  {
    name: 'bmad.update_story_status',
    description: 'Update story status',
    inputSchema: { type: 'object', required: ['story_id','status'], properties: { story_id: { type: 'string' }, status: { enum: ['draft','ready-for-dev','in-progress','review','done','blocked'] }, reason: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['success','previous_status'], properties: { success: { type: 'boolean' }, previous_status: { type: 'string' } } }
  },
  {
    name: 'bmad.complete_task',
    description: 'Mark a task or subtask as completed',
    inputSchema: { type: 'object', required: ['story_id','task_idx'], properties: { story_id: { type: 'string' }, task_idx: { type: 'number' }, subtask_idx: { type: 'number' }, completion_note: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['success','story_progress','all_tasks_done'], properties: {
      success: { type: 'boolean' }, story_progress: { type: 'object', required: ['done','total'], properties: { done: { type: 'number' }, total: { type: 'number' } } },
      next_task: { type: ['object','null'], properties: { idx: { type: 'number' }, description: { type: 'string' } } }, all_tasks_done: { type: 'boolean' }
    } }
  },
  {
    name: 'bmad.add_review_tasks',
    description: 'Add review follow-up tasks',
    inputSchema: { type: 'object', required: ['story_id','tasks'], properties: { story_id: { type: 'string' }, tasks: { type: 'array', items: { type: 'object', required: ['description','severity'], properties: { description: { type: 'string' }, severity: { enum: ['high','medium','low'] }, related_file: { type: 'string' } } } } } },
    outputSchema: { type: 'object', required: ['success','tasks_added'], properties: { success: { type: 'boolean' }, tasks_added: { type: 'number' } } }
  },
  {
    name: 'bmad.add_dev_note',
    description: 'Append development note',
    inputSchema: { type: 'object', required: ['story_id','note'], properties: { story_id: { type: 'string' }, note: { type: 'string' }, section: { enum: ['implementation','decisions','issues','general'] } } },
    outputSchema: { type: 'object', required: ['success'], properties: { success: { type: 'boolean' } } }
  },
  {
    name: 'bmad.register_files',
    description: 'Register changed files under a story',
    inputSchema: { type: 'object', required: ['story_id','files'], properties: { story_id: { type: 'string' }, files: { type: 'array', items: { type: 'object', required: ['path','change_type'], properties: { path: { type: 'string' }, change_type: { enum: ['added','modified','deleted'] } } } } } },
    outputSchema: { type: 'object', required: ['success','total_files'], properties: { success: { type: 'boolean' }, total_files: { type: 'number' } } }
  },
  {
    name: 'bmad.add_changelog_entry',
    description: 'Append a changelog entry',
    inputSchema: { type: 'object', required: ['story_id','entry'], properties: { story_id: { type: 'string' }, entry: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['success'], properties: { success: { type: 'boolean' } } }
  },
  {
    name: 'bmad.get_planning_doc',
    description: 'Fetch planning doc',
    inputSchema: { type: 'object', required: ['project_id','type','format'], properties: { project_id: { type: 'string' }, type: { enum: ['prd','architecture','epics','ux'] }, format: { enum: ['summary','full'] } } },
    outputSchema: { type: 'object', required: ['type','content','last_updated'], properties: { type: { type: 'string' }, content: { type: 'string' }, last_updated: { type: 'string' } } }
  },
  {
    name: 'bmad.update_planning_doc',
    description: 'Update planning doc',
    inputSchema: { type: 'object', required: ['project_id','type','content'], properties: { project_id: { type: 'string' }, type: { enum: ['prd','architecture','epics','ux'] }, content: { type: 'string' }, generate_summary: { type: 'boolean' } } },
    outputSchema: { type: 'object', required: ['success'], properties: { success: { type: 'boolean' } } }
  },
  {
    name: 'bmad.get_sprint_status',
    description: 'Get sprint status',
    inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['epics','summary'], properties: {
      current_sprint: { type: ['string','null'] },
      epics: { type: 'array', items: { type: 'object', required: ['number','title','status','stories'], properties: {
        number: { type: 'number' }, title: { type: 'string' }, status: { type: 'string' }, stories: { type: 'array', items: { type: 'object', required: ['key','title','status'], properties: { key: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } } } }
      } } },
      summary: { type: 'object', required: ['total_stories','by_status'], properties: { total_stories: { type: 'number' }, by_status: { type: 'object', additionalProperties: { type: 'number' } } } }
    } }
  },
  {
    name: 'bmad.log_action',
    description: 'Log orchestration action',
    inputSchema: { type: 'object', required: ['project_id','type','content'], properties: { project_id: { type: 'string' }, story_id: { type: 'string' }, type: { enum: ['dev','review','fix','create','pr'] }, content: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['success','log_id'], properties: { success: { type: 'boolean' }, log_id: { type: 'number' } } }
  },
  {
    name: 'bmad.export_story_md',
    description: 'Export a story to Markdown',
    inputSchema: { type: 'object', required: ['story_id'], properties: { story_id: { type: 'string' }, output_path: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['success','path'], properties: { success: { type: 'boolean' }, path: { type: 'string' } } }
  },
  {
    name: 'bmad.export_project_md',
    description: 'Export the project to Markdown files',
    inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' }, output_dir: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['success','exported'], properties: { success: { type: 'boolean' }, exported: { type: 'object', required: ['stories','planning_docs','logs'], properties: { stories: { type: 'number' }, planning_docs: { type: 'number' }, logs: { type: 'number' } } } } }
  },
  {
    name: 'bmad.import_project',
    description: 'Import a legacy BMAD project from files',
    inputSchema: { type: 'object', required: ['project_id','root_path'], properties: { project_id: { type: 'string' }, root_path: { type: 'string' }, bmad_output_path: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['success','imported'], properties: { success: { type: 'boolean' }, imported: { type: 'object', required: ['epics','stories','planning_docs'], properties: { epics: { type: 'number' }, stories: { type: 'number' }, planning_docs: { type: 'number' } } }, warnings: { type: 'array', items: { type: 'string' } } } }
  }
];

function asBundle() {
  return { name: 'bmad-mcp-schema', version: '0.1.0', tools };
}

module.exports = { tools, asBundle };

