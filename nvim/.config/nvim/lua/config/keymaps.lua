-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

local map = vim.keymap.set

-- 常用操作
map("n", "<C-s>", ":w<cr>", { desc = "Save file" })
map("n", "Q", ":q<cr>", { desc = "Quit" })
map("n", "|", ":vsplit<CR>", { desc = "Split Vertical" })
map("n", "-", ":split<CR>", { desc = "Split Horizontal" })

-- Buffer 操作 (LazyVim 默认自带，但保留你的习惯)
map("n", "<S-l>", ":bnext<CR>")
map("n", "<S-h>", ":bprevious<CR>")
map("n", "<Tab>", ":bnext<CR>")
map("n", "<S-Tab>", ":bprevious<CR>")

-- 功能增强
map("n", "<Leader>a=", ":Tab /^[^=]*\\zs=<CR>", { desc = "Align =" })
map("n", "<Leader>a:", ":Tab /:<CR>", { desc = "Align :" })
map("n", "<Leader>a,", ":Tab /,<CR>", { desc = "Align ," })
map("n", "<Leader>u", ":UndotreeToggle<CR>", { desc = "Toggle UndoTree" })
map("n", "<Leader>t", ":TagbarToggle<CR>", { desc = "Toggle Tagbar" })
map("n", "<Leader>.", ":terminal<CR>", { desc = "Terminal" })

-- 普通模式下：Tab / S-Tab 左右切换 Buffer
map("n", "<Tab>", "<cmd>bnext<cr>", { desc = "Next Buffer" })
map("n", "<S-Tab>", "<cmd>bprevious<cr>", { desc = "Prev Buffer" })

-- 快捷键：Leader + / 切换注释 (LazyVim 默认是 <leader>/)
-- 如果你想完全覆盖并确保生效：
-- 快捷键：Leader + / 切换注释 (适配 Neovim 0.10+ 原生注释)
map("n", "<leader>/", "gcc", { remap = true, desc = "Toggle Comment" })
map("v", "<leader>/", "gc", { remap = true, desc = "Toggle Comment" })

-- 鼠标开关
map("n", "<Leader>m", function()
  if vim.opt.mouse:get().a == "nv" then
    vim.opt.mouse = ""
    print("Mouse Disabled")
  else
    vim.opt.mouse = "nv"
    print("Mouse Enabled")
  end
end, { desc = "Toggle Mouse" })

-- 备份当前文件快捷键
map("n", "<leader>B", function()
  local dir = vim.fn.expand("%:p:h") .. "/"
  local filename = vim.fn.expand("%:t")
  vim.ui.input({
    prompt = "备份到：",
    default = dir .. filename .. ".bak",
    completion = "file",
  }, function(input)
    if input then
      vim.cmd("write! " .. input)
      print("已备份至: " .. input)
    end
  end)
end, { desc = "Backup current file" })
