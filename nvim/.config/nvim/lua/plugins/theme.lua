return {
  -- 1. 先确保安装了新主题插件
  { "catppuccin/nvim", name = "catppuccin", priority = 1000 },
  {
    "folke/tokyonight.nvim",
    opts = {
      -- 当主题加载高亮时，进行自定义修改
      on_highlights = function(hl, c)
        hl.WinSeparator = {
          fg = "#565f89", -- 使用主题色盘里的蓝色，或者直接写 "#7aa2f7"
          bold = true,
        }
      end,
    },
  },
  -- 2. 设置 LazyVim 使用它
  {
    "LazyVim/LazyVim",
    opts = {
      -- colorscheme = "catppuccin",
    },
  },
}
