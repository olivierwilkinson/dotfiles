return {
  "blindFS/vim-taskwarrior",
  name = "taskwarrior",
  cmd = { "TW", "TWEditTask", "TWAdd", "TWAnnotate", "TWComplete", "TWDelete", "TWModifyInteractive", "TWReportInfo", "TWReportSort", "TWSync", "TWToggleReadonly", "TWHistory", "TWHistoryClear", "TWBookmark", "TWBookmarkClear" },
  config = function()
    -- Set taskwarrior data location to brain
    vim.g.task_rc_override = 'rc.data.location=' .. vim.fn.expand("~/.brain/personal/tasks/")

    -- Default report
    vim.g.task_default_prompt = {'project', 'tag', 'description'}

    -- Key mappings for task management
    vim.g.task_readonly = 0
  end,
}
