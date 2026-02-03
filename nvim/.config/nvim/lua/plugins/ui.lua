return {
  { "folke/noice.nvim", enabled = false },
  {
    "folke/snacks.nvim",
    opts = {
      scroll = { enabled = false }, -- 彻底关闭平滑滚动，恢复原生硬切感
      terminal = {
        win = {
          position = "bottom", -- 可改为 "right" 让它在右侧显示
          height = 0.75,        -- 占用屏幕高度的 30%
        },
        wo = {
          winhighlight = "WinSeparator:SpecialChar", -- 使用更显眼的字符高亮
        },
      },
    },
  },
  {
    "akinsho/bufferline.nvim",
    opts = {
      options = {
        -- 始终显示标签栏，即使只有一个 buffer
        always_show_bufferline = true,
        -- 如果你希望显示左侧的偏移（例如配合 NvimTree/Neo-tree）
        offsets = {
          {
            filetype = "neo-tree",
            text = "File Explorer",
            highlight = "Directory",
            text_align = "left",
          },
        },
      },
    },
  },
  {
    "nvim-neo-tree/neo-tree.nvim",
    opts = {
      filesystem = {
        filtered_items = {
          visible = true,
          hide_dotfiles = false,
          hide_gitignored = false,
          hide_by_name = {
            ".DS_Store",
            "thumbs.db",
            "node_modules",
          },
        },
      },
    },
  },
}
