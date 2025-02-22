local wezterm = require 'wezterm'

local config = wezterm.config_builder()

-- remove tab bar when only one tab is open (tabs don't work with tmux auto session)
config.hide_tab_bar_if_only_one_tab = true

-- setup theme syncing with OS
function scheme_for_appearance(appearance)
  if appearance:find "Dark" then
    return "Catppuccin Mocha"
  else
    return "Catppuccin Frappe"
  end
end

config.color_scheme = scheme_for_appearance(wezterm.gui.get_appearance())

return config