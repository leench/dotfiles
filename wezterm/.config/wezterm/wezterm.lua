local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- 1. 系统判断逻辑
local is_mac = wezterm.target_triple:find("apple") ~= nil

config.term = "xterm-256color"
-- 强制使用 OpenGL 往往比 WebGpu 在处理字体边缘时更稳定
config.front_end = "OpenGL"
config.macos_window_background_blur = 20

-- 2. 字体与字号的动态设置
if is_mac then
  config.font = wezterm.font('VictorMono Nerd Font Mono')
  config.font_size = 13
  config.window_decorations = "TITLE | RESIZE"
  config.initial_cols = 220
  config.initial_rows = 45
  config.native_macos_fullscreen_mode = false

  wezterm.on('gui-startup', function(cmd)
    local _, _, window = wezterm.mux.spawn_window(cmd or {})
    local gui_window = window:gui_window()
    local screens = wezterm.gui.screens()
    local active_screen = screens.active or screens.main or screens.visual[1]

    if active_screen then
      local screen_width = active_screen.width
      local screen_height = active_screen.height
      local dims = gui_window:get_dimensions()
      local x = (screen_width - dims.pixel_width) / 2
      local menu_bar_height = 25 
      local y = (screen_height - menu_bar_height - dims.pixel_height) / 2 + menu_bar_height
      gui_window:set_position(x, y)
    end
  end)
else
  -- 针对你的 Arch Linux 环境 (同步 Kitty 设置并修复裁切)
  config.font = wezterm.font('JetBrains Mono')
  config.font_size = 10.5
  config.line_height = 1.2
  config.default_cursor_style = 'SteadyBar'
end

-- 3. 字体渲染微调 (核心修复：关闭微调以防止裁切)
config.freetype_render_target = 'HorizontalLcd'

-- 4. 窗口装饰
config.hide_tab_bar_if_only_one_tab = false
config.use_fancy_tab_bar = false
config.window_padding = {
  left = 6,
  right = 6,
  top = 6,
  bottom = 6,
}
config.window_frame = {
  font_size = 11.0,
}

-- 5. 颜色方案
config.window_background_opacity = 0.90
config.force_reverse_video_cursor = false

config.colors = {
  foreground = '#FFFFFF',
  background = '#000000',
  cursor_bg = '#88C0D0',
  cursor_fg = '#2E3440',
  selection_bg = '#88C0D0',
  selection_fg = '#2E3440',

  ansi = { '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#FFFFFF' },
  brights = { '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#FFFFFF' },
}

-- 禁用变暗
config.inactive_pane_hsb = {
  saturation = 1.0,
  brightness = 1.0,
}

-- 7. 快捷键配置
config.keys = {
  { key = 'v', mods = 'CTRL', action = wezterm.action.PasteFrom 'Clipboard' },
  {
    key = 'c',
    mods = 'CTRL',
    action = wezterm.action_callback(function(window, pane)
      local has_selection = window:get_selection_text_for_pane(pane) ~= ""
      if has_selection then
        window:perform_action(wezterm.action.CopyTo 'ClipboardAndPrimarySelection', pane)
        window:perform_action(wezterm.action.ClearSelection, pane)
      else
        window:perform_action(wezterm.action.SendKey { key = 'c', mods = 'CTRL' }, pane)
      end
    end),
  },
}

config.window_close_confirmation = 'NeverPrompt'

return config
