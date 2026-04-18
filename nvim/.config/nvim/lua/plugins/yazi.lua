return {
  "mikavilpas/yazi.nvim",
  event = "VeryLazy",
  keys = {
    {
      "<leader>-",
      "<cmd>Yazi<cr>",
      desc = "在当前文件路径打开 Yazi",
    },
    {
      "<leader>cw",
      "<cmd>Yazi cwd<cr>",
      desc = "在当前工作目录打开 Yazi",
    },
    {
      "<c-up>",
      "<cmd>Yazi toggle<cr>",
      desc = "切换上次 Yazi 会话",
    },
  },
  ---@type YaziConfig
  opts = {
    open_for_directories = false,
    keymaps = {
      show_help = "<f1>",
    },
  },
}
