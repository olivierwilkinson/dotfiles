return {
  "FabijanZulj/blame.nvim",
  lazy = true,
  config = function()
    require('blame').setup {
      virtual_style = "float"
    }
  end,
}
