return {
  {
    "kevinhwang91/nvim-ufo",
    lazy = false,
    dependencies = { "kevinhwang91/promise-async" },
    init = function()
      vim.o.foldcolumn = "1"
      vim.o.foldlevel = 99
      vim.o.foldlevelstart = 99
      vim.o.foldenable = true
    end,
    opts = {
      provider_selector = function()
        return { "treesitter", "indent" }
      end,
    },
    keys = {
      { "zR", function() require("ufo").openAllFolds() end, desc = "Open all folds" },
      { "zM", function() require("ufo").closeAllFolds() end, desc = "Close all folds" },
    },
  },
  {
    "folke/snacks.nvim",
    opts = {
      statuscolumn = {
        folds = { open = true },
      },
    },
  },

  -- 主题
  -- { "folke/tokyonight.nvim", opts = { style = "moon" } },
  -- 静态对齐插件
  { "godlygeek/tabular" },
  -- 你习惯使用的传统插件
  { "mbbill/undotree" },
  { "preservim/tagbar" },
  { "tpope/vim-surround" },

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
  {
    "nvim-pack/nvim-spectre",
    dependencies = { "nvim-lua/plenary.nvim" },
    cmd = "Spectre",
    keys = {
      { "<leader>Ss", '<cmd>lua require("spectre").toggle()<cr>', desc = "Toggle Spectre (全局替换)" },
      { "<leader>Sw", '<cmd>lua require("spectre").open_visual({select_word=true})<cr>', desc = "Spectre 搜索光标单词" },
      { "<leader>Sp", '<cmd>lua require("spectre").open_file_search({select_word=true})<cr>', desc = "仅在当前文件中搜索替换" },
    },
    opts = {
      -- 默认配置通常已经足够，你可以在这里覆盖默认行为
      open_cmd = 'vnew', -- 在垂直分割窗口打开
      is_insert_mode = false, -- 进入面板时不默认进入插入模式
      live_update = true, -- 输入时实时更新预览
      line_sep_start = '┌-----------------------------------------',
      result_padding = '  ',
      line_sep       = '└-----------------------------------------',
      highlight = {
        ui = "String",
        search = "DiffDelete",
        replace = "DiffAdd"
      },
      find_engine = {
        ['rg'] = {
          args = {
            '--color=never',
            '--no-heading',
            '--with-filename',
            '--line-number',
            '--column',
            '--ignore',      -- 启用忽略规则
            '--hidden',      -- 关键：搜索隐藏文件 (如 .env)
            '--no-ignore',   -- 关键：不忽略 .gitignore 中的文件
          }
        }
      },
      mapping = {
        -- 面板内的快捷键映射
        ['toggle_line'] = {
          map = "dd",
          cmd = [[<cmd>lua require('spectre').toggle_line()<CR>]],
          desc = "排除当前行"
        },
        ['run_replace'] = {
          map = "<leader>R",
          cmd = [[<cmd>lua require('spectre.actions').run_replace()<CR>]],
          desc = "执行全局替换"
        },
      }
    },
  },
}
