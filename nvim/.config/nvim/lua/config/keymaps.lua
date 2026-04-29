-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

local map = vim.keymap.set

-- 常用操作
map("n", "<C-s>", ":w<cr>", { desc = "Save file" })
map("n", "Q", ":q<cr>", { desc = "Quit" })
map("n", "|", ":vsplit<CR>", { desc = "Split Vertical" })
map("n", "-", ":split<CR>", { desc = "Split Horizontal" })

-- 修改时不覆盖寄存器
map({ "n", "x" }, "c", '"_c', { noremap = true })
map({ "n", "x" }, "C", '"_C', { noremap = true })

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

-- 🐍 Python: 清理未使用的导入 (需要 pip install ruff)
map("n", "<leader>ri", function()
  if vim.bo.filetype ~= "python" then
    print("❌ 仅支持 Python 文件")
    return
  end
  local file = vim.api.nvim_buf_get_name(0)
  -- F401 是 "imported but unused" 的规则代码
  vim.cmd("silent !ruff check --select F401 --fix " .. vim.fn.shellescape(file))
  vim.cmd("edit!")
  print("✨ 已通过 Ruff 清理未使用的导入")
end, { desc = "Remove unused Python imports (Ruff)" })

-- 定义一个函数来运行你的 TUI
local function run_atui()
  -- 替换为你 TUI 的实际命令和固定目录
  local cmd = "atui" 
  local dir = "/webprojects/gzstv/GZSTVSite/ansible/"

  -- 调用 Snacks 开启浮窗终端
  Snacks.terminal.open(cmd, {
    cwd = vim.fn.expand(dir),
    interactive = true,
    -- 这里的 style 可以匹配 LazyVim 的浮窗风格
    win = {
      style = "float",
      border = "rounded",
      width = 0.9,
      height = 0.9,
    },
  })
end

-- 设置快捷键，例如 <leader>ty (tui yours)
vim.keymap.set("n", "<leader>dj", run_atui, { desc = "Ansible Tui" })

-- 复制当前文件路径
map("n", "<leader>fy", function()
  local path = vim.api.nvim_buf_get_name(0)
  if path == "" then
    vim.notify("无有效文件路径", vim.log.levels.WARN)
    return
  end
  local root = LazyVim.root()
  local rel_path = vim.fn.fnamemodify(path, ":.")
  -- 如果 fnamemodify 返回了绝对路径（说明不在 CWD 下），或者我们想要强制相对于项目根目录
  if rel_path:sub(1, 1) == "/" or rel_path:sub(2, 2) == ":" then
    rel_path = path:gsub("^" .. vim.pesc(root .. "/"), "")
  end
  vim.fn.setreg("+", rel_path)
  vim.notify("已复制相对路径: " .. rel_path)
end, { desc = "Copy Relative Path" })

map("n", "<leader>fY", function()
  local path = vim.api.nvim_buf_get_name(0)
  if path == "" then
    vim.notify("无有效文件路径", vim.log.levels.WARN)
    return
  end
  vim.fn.setreg("+", path)
  vim.notify("已复制绝对路径: " .. path)
end, { desc = "Copy Absolute Path" })
