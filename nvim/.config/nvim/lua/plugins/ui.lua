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
    "folke/snacks.nvim",
    opts = {
      picker = {
        sources = {
          explorer = {
            hidden = true,
            ignored = true,
          },
          files = {
            hidden = true, -- show dotfiles in fuzzy finder
            ignored = true, -- optional: show gitignored files
          },
        },
      },
    },
  },
  -- {
  --   "nvim-neo-tree/neo-tree.nvim",
  --     -- 禁用默认 keymap，自己接管
  --   keys = {
  --     -- <space>e → 打开项目根目录
  --     {
  --       "<leader>e",
  --       function()
  --         require("neo-tree.command").execute({
  --           toggle = true,
  --           dir = vim.loop.cwd(),
  --         })
  --       end,
  --       desc = "NeoTree (root dir)",
  --     },
  --
  --     -- <space>E → 打开当前文件所在目录
  --     {
  --       "<leader>E",
  --       function()
  --         local path = vim.fn.expand("%:p:h")
  --         require("neo-tree.command").execute({
  --           toggle = true,
  --           dir = path,
  --         })
  --       end,
  --       desc = "NeoTree (current file dir)",
  --     },
  --   },
  --
  --   init = function()
  --     -- 禁用 netrw（非常重要）
  --     vim.g.loaded_netrw = 1
  --     vim.g.loaded_netrwPlugin = 1
  --   end,
  --
  --   opts = {
  --     close_if_last_window = true,
  --     popup_border_style = "rounded",
  --
  --     filesystem = {
  --       follow_current_file = {
  --         enabled = true,
  --       },
  --
  --       filtered_items = {
  --         visible = true,
  --         hide_dotfiles = false,
  --         hide_gitignored = false,
  --         hide_hidden = false,
  --         hide_ignored = false,
  --         never_show = {},
  --       },
  --     },
  --   },
  -- },
}
