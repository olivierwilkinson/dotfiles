return {
    "mason-org/mason-lspconfig.nvim",
    opts = {
        ensure_installed = { "vtsls", "lua_ls" }
    },
    dependencies = {
        { "mason-org/mason.nvim", opts = {} },
    },
}