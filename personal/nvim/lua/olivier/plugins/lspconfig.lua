return {
  {
    "neovim/nvim-lspconfig",
    config = function()
      local lspconfig = require('lspconfig');
      lspconfig.lua_ls.setup({
        Lua = {
          diagnostics = {
            globals = { "vim" }
          }
        }
      })
    end,
  },
}
