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
        lua = {"lua-format"},
        css = {"prettier"},
        scss = {"prettier"}
      };

      vim.keymap.set("n", "<leader>af", "<cmd>ALEFix<cr>", {desc = "ALEFix the current file"})
      vim.keymap.set("n", "<leader>aj", "<cmd>ALENext<cr>", {desc = "ALENext"})
      vim.keymap.set("n", "<leader>ak", "<cmd>ALEPrevious<cr>", {desc = "ALEPrevious"})
      vim.keymap.set("n", "<leader>aej", "<cmd>ALENext -error<cr>", {desc = "ALENext error"})
      vim.keymap.set("n", "<leader>aek", "<cmd>ALEPrevious -error<cr>", {desc = "ALEPrevious error"})
      vim.keymap.set("n", "<leader>awj", "<cmd>ALENext -warning<cr>", {desc = "ALENext warning"})
      vim.keymap.set("n", "<leader>awk", "<cmd>ALEPrevious -warning<cr>", {desc = "ALEPrevious warning"})
    end
}
