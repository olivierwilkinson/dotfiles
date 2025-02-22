return {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    config = function()
      local configs = require("nvim-treesitter.configs")

      configs.setup({
        ensure_installed = {
          "c", "lua", "vim", "vimdoc", "elixir", "javascript", "html", "python", "typescript", "graphql", "ruby", "yaml", "json", "toml", "markdown", "markdown_inline", "bash", "dockerfile", "gitignore", "sql", "css", "scss"
        },
        sync_install = false,
        highlight = { enable = true },
        indent = { enable = true },
      })
    end
}
