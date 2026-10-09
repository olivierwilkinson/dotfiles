return {
    "mason-org/mason-lspconfig.nvim",
    dependencies = {
        { "mason-org/mason.nvim", opts = {} },
        "neovim/nvim-lspconfig",
    },
    config = function()
        require("mason-lspconfig").setup({
            ensure_installed = { "tsgo", "lua_ls" },
            automatic_enable = false,
        })

        vim.lsp.config("tsgo", {
            root_markers = { "package.json", "tsconfig.json", ".git" },
            init_options = {
                preferences = {
                    importModuleSpecifierPreference = "non-relative",
                },
            },
        })

        vim.lsp.config("lua_ls", {
            settings = {
                Lua = {
                    diagnostics = {
                        globals = { "vim" },
                    },
                },
            },
        })

        vim.lsp.enable("tsgo")
        vim.lsp.enable("lua_ls")
        vim.lsp.enable("ts_ls", false)
    end,
}
