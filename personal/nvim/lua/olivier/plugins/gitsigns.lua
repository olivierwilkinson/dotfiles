return {
  "lewis6991/gitsigns.nvim",
  name = "gitsigns",
  config = function()
     require("gitsigns").setup({
         -- Configuration here, or leave empty to use defaults
        on_attach = function(bufnr)

        local gitsigns = require('gitsigns')

        local function map(mode, l, r, opts)
          opts = opts or {}
          opts.buffer = bufnr
          vim.keymap.set(mode, l, r, opts)
        end

        -- Actions
        map('n', '<leader>gs', gitsigns.stage_hunk)
        map('n', '<leader>gr', gitsigns.reset_hunk)

        map('n', '<leader>gj', function()
          gitsigns.nav_hunk("next")
        end)
        map('n', '<leader>gk', function()
          gitsigns.nav_hunk("prev")
        end)

        map('v', '<leader>gs', function()
          gitsigns.stage_hunk({ vim.fn.line('.'), vim.fn.line('v') })
        end)

        map('v', '<leader>gr', function()
          gitsigns.reset_hunk({ vim.fn.line('.'), vim.fn.line('v') })
        end)

        map('n', '<leader>gS', gitsigns.stage_buffer)
        map('n', '<leader>gR', gitsigns.reset_buffer)
        map('n', '<leader>gp', gitsigns.preview_hunk)
        map('n', '<leader>gi', gitsigns.preview_hunk_inline)

        map('n', '<leader>gb', function()
          gitsigns.blame_line({ full = true })
        end)

        map('n', '<leader>gd', gitsigns.diffthis)

        map('n', '<leader>gD', function()
          gitsigns.diffthis('~')
        end)

        map('n', '<leader>gQ', function() gitsigns.setqflist('all') end)
        map('n', '<leader>gq', gitsigns.setqflist)

        -- Toggles
        map('n', '<leader>gtb', gitsigns.toggle_current_line_blame)
        map('n', '<leader>gtw', gitsigns.toggle_word_diff)

        -- Text object
        map({'o', 'x'}, 'ih', gitsigns.select_hunk)
      end
     })
  end
}
