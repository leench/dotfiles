local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- 1. 系统判断逻辑
local is_mac = wezterm.target_triple:find("apple") ~= nil

config.term = "xterm-256color"

-- 2. 字体与字号的动态设置
if is_mac then
  -- macOS 特有配置
  config.font = wezterm.font('VictorMono Nerd Font Mono')
  config.font_size = 13
  config.window_decorations = "TITLE | RESIZE"
  config.macos_window_background_blur = 20
  config.initial_cols = 220 -- 建议先用这个值，等稳定了再调大
  config.initial_rows = 45
  config.native_macos_fullscreen_mode = false


  wezterm.on('gui-startup', function(cmd)
    -- 注意：这里使用 mux.spawn_window 之后，
    -- 确保没有其它的默认窗口逻辑干扰
    local _, _, window = wezterm.mux.spawn_window(cmd or {})
    local gui_window = window:gui_window()
    local screens = wezterm.gui.screens()
    local active_screen = screens.active or screens.main or screens.visual[1]

    if active_screen then
      local screen_width = active_screen.width
      local screen_height = active_screen.height
      -- 重点：刚启动时可能拿不到像素大小，这里可以稍微等一两个 tick
      -- 或者直接通过列数计算（但这比较复杂），我们先直接设置
      local dims = gui_window:get_dimensions()

      local x = (screen_width - dims.pixel_width) / 2
      -- y 轴偏移量，macOS 菜单栏 25px 左右，你设置 100 会偏下一点，看你喜好
      local menu_bar_height = 25 
      local y = (screen_height - menu_bar_height - dims.pixel_height) / 2 + menu_bar_height

      gui_window:set_position(x, y)
    end
  end)
else
  -- 针对你的 Arch Linux 环境
  config.font = wezterm.font('Noto Sans Mono')
  config.font_size = 10.0
end

-- 3. 解决“有标题栏但 Tab Bar 消失”的问题
-- 在 macOS 上，如果你只想要标题栏和 Tab Bar 共存：
config.hide_tab_bar_if_only_one_tab = false -- 即使只有一个标签也强制显示 Tab Bar
config.use_fancy_tab_bar = false             -- 使用更现代的标签栏样式

-- 4. 解决 SSH 稳定性问题
-- 方式 A：如果你想手动定义特定的 Domain (修正报错)
config.ssh_domains = {
  {
    name = 'my_server',
    remote_address = 'localhost', -- 必须提供，即使不直接使用它连接
    -- 只有当你远程也安装了 wezterm 并想开启“断线重连”黑科技时才用下面这行
    -- multiplexing = "WezTerm", 
  },
}

-- 方式 B：全局防掉线 (最推荐，不需要修改 s() 函数)
-- 增加这个设置可以让 WezTerm 的底层连接更坚固
config.force_reverse_video_cursor = true

-- 5. UI 与透明度优化 (适配你之前的 Neovim 透明需求)
config.color_scheme = 'Catppuccin Macchiato'
config.window_background_opacity = 0.95

-- 7. 快捷键配置 (如果你习惯 Cmd + Enter 最大化)
config.keys = {
}

-- 'NeverPrompt': 无论如何都不提示，直接关闭
config.window_close_confirmation = 'NeverPrompt'

return config
