return {
    'dense-analysis/ale',
    config = function()
      local g = vim.g

      g.ale_fix_on_save = true
      g.ale_fixers = {
        javascript = {"eslint", "prettier"},
        javascriptreact = {"eslint", "prettier"},
        typescript =  {"eslint", "prettier"},
        typescriptreact =  {"eslint", "prettier"},
        lua = {"lua-format"}
      };

      vim.keymap.set("n", "<leader>af", "<cmd>ALEFix<cr>", {desc = "ALEFix the current file"})
    end
}
