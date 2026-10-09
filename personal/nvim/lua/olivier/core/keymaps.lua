vim.g.mapleader = ","

-- use jk to exit insert mode
vim.keymap.set("i", "jk", "<ESC>", { desc = "Exit insert mode with jk" })

-- open code actions menu
vim.keymap.set('n', '<space>ca', function() vim.lsp.buf.code_action({apply=true}) end, bufopts)

-- copy relative filepath to clipboard
vim.keymap.set('n', '<leader>rp', '<cmd>let @+ = fnamemodify(expand("%"), ":.")<CR>');

