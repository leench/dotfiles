return {
  "ellisonleao/glow.nvim",
  cmd = "Glow",
  opts = {
    width_ratio = 0.8,
    height_ratio = 0.9,
    style = "dark", -- 显式设置样式，解决部分环境下单色显示的问题
  },
  keys = {
    { "<leader>gm", "<cmd>Glow<cr>", desc = "Glow Markdown Preview" },
  },
}
