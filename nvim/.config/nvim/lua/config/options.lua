-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

vim.g.autoformat = false

-- 基础选项
vim.g.mapleader = " "
vim.g.maplocalleader = " "
vim.opt.termguicolors = true

local opt = vim.opt

opt.backup = false
opt.showmode = true
opt.colorcolumn = "80"
opt.shell = "/bin/zsh"
opt.laststatus = 3 -- 全局状态栏
opt.modifiable = true

-- Python 宿主路径 (你配置中的路径)
-- vim.g.python3_host_prog = "/webprojects/gzstv/env/bin/python3.11"

-- 针对特定文件类型的缩进设置 (替代原来的 autocmd)
vim.api.nvim_create_autocmd("FileType", {
  pattern = "python",
  callback = function()
    opt.shiftwidth = 4
    opt.tabstop = 4
    opt.softtabstop = 4
    opt.expandtab = true
    opt.textwidth = 79
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = "javascript",
  callback = function()
    opt.shiftwidth = 2
    opt.tabstop = 2
    opt.softtabstop = 2
    opt.expandtab = true
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = "lua",
  callback = function()
    vim.opt_local.shiftwidth = 2
    vim.opt_local.tabstop = 2
    vim.opt_local.softtabstop = 2
    vim.opt_local.expandtab = true
  end,
})
