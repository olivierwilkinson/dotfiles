-- nvim-treesitter's main branch: it installs parsers (with the tree-sitter CLI) and queries, and
-- leaves starting highlighting and indentation to each buffer.
return {
    "nvim-treesitter/nvim-treesitter",
    branch = "main",
    lazy = false,
    build = ":TSUpdate",
    config = function()
      require("nvim-treesitter").install({
        "c", "lua", "vim", "vimdoc", "elixir", "javascript", "html", "python", "typescript", "graphql", "ruby", "yaml", "json", "toml", "markdown", "markdown_inline", "bash", "dockerfile", "gitignore", "sql", "css", "scss", "tlaplus"
      })

      vim.api.nvim_create_autocmd("FileType", {
        group = vim.api.nvim_create_augroup("olivier-treesitter", { clear = true }),
        callback = function(args)
          if pcall(vim.treesitter.start, args.buf) then
            vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
          end
        end,
      })
    end
}
