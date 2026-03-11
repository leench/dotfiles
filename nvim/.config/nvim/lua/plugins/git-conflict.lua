return {
  "akinsho/git-conflict.nvim",
  version = "*",
  config = function()
    require("git-conflict").setup({
      default_mappings = true, -- 使用默认快捷键
      disable_diagnostics = false, -- 在冲突区域禁用诊断以减少干扰
      list_opener = "copen", -- 出现冲突时自动打开 quickfix 列表
      highlights = {
        incoming = "DiffText",
        current = "DiffAdd",
      },
    })

    -- 额外的快捷键提示：
    -- [x / ]x : 导航到上一个/下一个冲突
    -- co      : 使用 OURS (Choose Ours)
    -- ct      : 使用 THEIRS (Choose Theirs)
    -- cb      : 使用 BOTH (Choose Both)
    -- c0      : 均不使用 (Choose None)
  end,
}
