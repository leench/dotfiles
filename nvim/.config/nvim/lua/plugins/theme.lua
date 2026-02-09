return {
  -- 1. 先确保安装了新主题插件
  {
    "catppuccin/nvim",
    opts = {
      -- name = "catppuccin",
      -- priority = 1000,
      flavour = "mocha", -- latte, frappe, macchiato, mocha
      background = { -- :h background
        light = "frappe",
        dark = "frappe",
      },
    },
  },
  { "ellisonleao/gruvbox.nvim" },
  {
    "folke/tokyonight.nvim",
    opts = {
      style = "moon", -- 恢复为 moon 模式
      transparent = false, -- 关闭背景透明，让主题自带背景色
      styles = {
        sidebars = "dark",
        floats = "dark",
      },
      -- 当主题加载高亮时，进行自定义修改
      -- on_highlights = function(hl, c)
      --   hl.WinSeparator = {
      --     fg = "#565f89", -- 使用主题色盘里的蓝色，或者直接写 "#7aa2f7"
      --     bold = true,
      --   }
      -- end,
    },
  },
  -- 2. 设置 LazyVim 使用它
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "tokyonight",
    },
  },
}
