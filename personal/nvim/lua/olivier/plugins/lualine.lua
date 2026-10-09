return {
  'nvim-lualine/lualine.nvim',
  dependencies = { 'nvim-tree/nvim-web-devicons' },
  opts = {
    options = {
      icons_enabled = true,
    },
    sections = {},
    winbar = {
      lualine_a = {'mode'},
      lualine_b = {'diff', 'diagnostics'},
      lualine_c = {'filename'},
      lualine_x = {},
      lualine_y = {'progress'},
      lualine_z = {'location'}
    },
  },
}
