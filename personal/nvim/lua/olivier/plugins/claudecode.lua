return {
  "coder/claudecode.nvim",
  dependencies = {
    "folke/snacks.nvim",
  },
  lazy = false,
  priority = 1000,
  config = true,
  opts = {
    auto_start = false,
    terminal_cmd = "devx claude",
    terminal = {
      provider = require("olivier.terminal.tmux"),
      provider_opts = {
        split_direction = "vertical", -- "vertical" (side by side) or "horizontal" (stacked)
        size = 40, -- percentage of screen
        focus_on_open = true,
      },
    },
    diff_opts = {
      auto_close_on_accept = true,
      vertical_split = true,
      open_in_current_tab = false,
      keep_terminal_focus = true,
    },
  },
  keys = {
    { "<leader>c", nil, desc = "AI/Claude Code" },
    { "<leader>cc", "<cmd>ClaudeCode<cr>", desc = "Toggle Claude" },
    { "<leader>cf", "<cmd>ClaudeCodeFocus<cr>", desc = "Focus Claude" },
    { "<leader>cr", "<cmd>ClaudeCode --resume<cr>", desc = "Resume Claude" },
    { "<leader>cC", "<cmd>ClaudeCode --continue<cr>", desc = "Continue Claude" },
    { "<leader>cm", "<cmd>ClaudeCodeSelectModel<cr>", desc = "Select Claude model" },
    { "<leader>cb", "<cmd>ClaudeCodeAdd %<cr>", desc = "Add current buffer" },
    { "<leader>cs", "<cmd>ClaudeCodeSend<cr>", mode = "v", desc = "Send to Claude" },
    {
      "<leader>cs",
      "<cmd>ClaudeCodeTreeAdd<cr>",
      desc = "Add file",
      ft = { "NvimTree", "neo-tree", "oil", "minifiles", "netrw" },
    },
    -- Diff management
    { "<leader>ca", "<cmd>ClaudeCodeDiffAccept<cr>", desc = "Accept diff" },
    { "<leader>cd", "<cmd>ClaudeCodeDiffDeny<cr>", desc = "Deny diff" },
  },
}
