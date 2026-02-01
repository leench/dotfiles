return {
  -- 主题
  -- { "folke/tokyonight.nvim", opts = { style = "moon" } },
  -- 静态对齐插件
  { "godlygeek/tabular" },
  -- 你习惯使用的传统插件
  { "mbbill/undotree" },
  { "preservim/tagbar" },
  { "tpope/vim-surround" },
  { "tversteeg/registers.nvim", opts = {} },

  -- Mason / Null-ls (现在叫 none-ls)
  -- 注意：LazyVim 建议使用 conform.nvim 进行格式化
  {
    "stevearc/conform.nvim",
    opts = {
      formatters_by_ft = {
        python = { "isort", "black" },
      },
    },
  },
}
