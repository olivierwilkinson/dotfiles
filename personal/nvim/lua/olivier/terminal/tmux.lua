-- Custom tmux terminal provider for claudecode.nvim
-- Opens Claude Code in a tmux pane instead of a Neovim terminal
-- Scoped per-window: each tmux window gets its own Claude pane

local M = {}

local config = {}

-- Store pane IDs per window: { [window_id] = pane_id }
local window_panes = {}

-- Check if we're running inside tmux
local function in_tmux()
  return vim.env.TMUX ~= nil and vim.env.TMUX ~= ""
end

-- Execute a tmux command and return output
local function tmux(args)
  local cmd = "tmux " .. args
  local handle = io.popen(cmd .. " 2>&1")
  if not handle then
    return nil, "Failed to execute tmux command"
  end
  local result = handle:read("*a")
  local success = handle:close()
  if success then
    return vim.trim(result or ""), nil
  end
  return nil, result
end

-- Get the current tmux window ID
local function get_current_window_id()
  return tmux("display-message -p '#{window_id}'")
end

-- Get the pane ID for the current window
local function get_pane_id()
  local window_id = get_current_window_id()
  if not window_id then
    return nil
  end
  return window_panes[window_id]
end

-- Set the pane ID for the current window
local function set_pane_id(pane_id)
  local window_id = get_current_window_id()
  if window_id then
    window_panes[window_id] = pane_id
  end
end

-- Clear the pane ID for the current window
local function clear_pane_id()
  local window_id = get_current_window_id()
  if window_id then
    window_panes[window_id] = nil
  end
end

-- Check if the pane still exists (in current window)
local function pane_exists()
  local pane_id = get_pane_id()
  if not pane_id then
    return false
  end
  -- List panes only in the current window
  local result = tmux("list-panes -F '#{pane_id}'")
  if not result then
    return false
  end
  return result:find(pane_id, 1, true) ~= nil
end

-- Check if the pane is currently focused
local function pane_focused()
  local pane_id = get_pane_id()
  if not pane_id or not pane_exists() then
    return false
  end
  local result = tmux("display-message -p '#{pane_id}'")
  return result == pane_id
end

-- Build environment string for tmux
local function build_env_string(env_table)
  if not env_table or vim.tbl_isempty(env_table) then
    return ""
  end
  local parts = {}
  for key, value in pairs(env_table) do
    -- Escape single quotes in values
    local escaped_value = tostring(value):gsub("'", "'\"'\"'")
    table.insert(parts, string.format("%s='%s'", key, escaped_value))
  end
  return table.concat(parts, " ") .. " "
end

-- Get the split direction flag
local function get_split_flag()
  if config.split_direction == "horizontal" then
    return "-v" -- tmux -v creates a horizontal split (panes stacked vertically)
  else
    return "-h" -- tmux -h creates a vertical split (panes side by side)
  end
end

-- Get the size flag
local function get_size_flag()
  local size = config.size or 40
  return string.format("-l %d%%", size)
end

-- Setup the provider
function M.setup(term_config)
  config = vim.tbl_deep_extend("force", {
    split_direction = "vertical", -- "vertical" (side by side) or "horizontal" (stacked)
    size = 40, -- percentage of screen
    focus_on_open = true,
  }, term_config.provider_opts or {})
end

-- Check if tmux is available
function M.is_available()
  return in_tmux()
end

-- Open the terminal
function M.open(cmd_string, env_table, effective_config, focus)
  if not in_tmux() then
    vim.notify("Not running inside tmux", vim.log.levels.ERROR)
    return
  end

  local pane_id = get_pane_id()

  -- If pane exists in current window, optionally focus it
  if pane_exists() then
    if focus or config.focus_on_open then
      tmux(string.format("select-pane -t %s", pane_id))
    end
    return
  end

  -- Create new pane in current window
  local env_string = build_env_string(env_table)
  local split_flag = get_split_flag()
  local size_flag = get_size_flag()
  local cwd = vim.fn.getcwd()

  -- Create the pane and capture its ID
  local new_pane_id, err = tmux(string.format(
    "split-window %s %s -c '%s' -P -F '#{pane_id}' '%s%s'",
    split_flag,
    size_flag,
    cwd,
    env_string,
    cmd_string
  ))

  if err or not new_pane_id or new_pane_id == "" then
    vim.notify("Failed to create tmux pane: " .. (err or "unknown error"), vim.log.levels.ERROR)
    return
  end

  set_pane_id(vim.trim(new_pane_id))

  -- Return focus to nvim pane if not focusing on open
  if not focus and not config.focus_on_open then
    tmux("select-pane -l")
  end
end

-- Close the terminal
function M.close()
  local pane_id = get_pane_id()
  if pane_id and pane_exists() then
    tmux(string.format("kill-pane -t %s", pane_id))
  end
  clear_pane_id()
end

-- Simple toggle: show if hidden, hide if visible
function M.simple_toggle(cmd_string, env_table, effective_config)
  if not in_tmux() then
    vim.notify("Not running inside tmux", vim.log.levels.ERROR)
    return
  end

  if pane_exists() then
    M.close()
  else
    M.open(cmd_string, env_table, effective_config, config.focus_on_open)
  end
end

-- Focus toggle: hide if focused, show/focus otherwise
function M.focus_toggle(cmd_string, env_table, effective_config)
  if not in_tmux() then
    vim.notify("Not running inside tmux", vim.log.levels.ERROR)
    return
  end

  local pane_id = get_pane_id()

  if pane_focused() then
    -- Return to previous pane (likely nvim)
    tmux("select-pane -l")
  elseif pane_exists() then
    -- Pane exists but not focused, focus it
    tmux(string.format("select-pane -t %s", pane_id))
  else
    -- Pane doesn't exist, open it
    M.open(cmd_string, env_table, effective_config, true)
  end
end

-- Legacy toggle
function M.toggle(cmd_string, env_table, effective_config)
  M.simple_toggle(cmd_string, env_table, effective_config)
end

-- Ensure the terminal is visible (no-op for per-window scoping)
function M.ensure_visible()
  -- With per-window scoping, the pane is either in this window or doesn't exist
  -- Nothing to do here
end

-- Get active buffer number (N/A for tmux, return nil)
function M.get_active_bufnr()
  -- tmux panes don't have Neovim buffer numbers
  return nil
end

-- Test helper
function M._get_terminal_for_test()
  local pane_id = get_pane_id()
  return {
    pane_id = pane_id,
    window_id = get_current_window_id(),
    exists = pane_exists(),
    focused = pane_focused(),
    all_window_panes = window_panes,
  }
end

return M
