return {
  "ellisonleao/glow.nvim",
  cmd = "Glow",
  config = function(_, opts)
    -- 强制设置环境变量，让 glow 在任何环境下都带颜色输出
    vim.env.CLICOLOR_FORCE = "1"
    require("glow").setup(opts)
  end,
  opts = {
    width_ratio = 0.8,
    height_ratio = 0.9,
    style = "dark",
  },
  keys = {
    { "<leader>gm", "<cmd>Glow<cr>", desc = "Glow Markdown Preview" },
  },
}
