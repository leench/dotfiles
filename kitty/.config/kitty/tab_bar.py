from functools import lru_cache
from pathlib import Path
import os

from kitty.fast_data_types import Screen
from kitty.tab_bar import (DrawData,
                         TabBarData,
                         ExtraData,
                         TabAccessor,
                         draw_tab_with_powerline,
                         )

# --- TOKYO NIGHT MOON 配色方案 ---
# 选中状态：亮蓝色 (#82aaff) 配合深紫底色
# 未选中：灰蓝色 (#545c7e)
COLOR_ACTIVE_PATH = "#82aaff"
COLOR_INACTIVE_PATH = "#545c7e"
COLOR_ICON = "#4fd6be" # 青色图标

_home = os.path.expanduser("~")

@lru_cache(maxsize=32)
def get_short_path(cwd: str) -> tuple[str, ...]:
    global _home
    if cwd.startswith(_home):
        cwd = "~" + cwd[len(_home):]
    if cwd.startswith("~/projects"):
        cwd = "~/p" + cwd[10:]
    parts = cwd.strip("/").split("/")
    if len(parts) > 3:
        return tuple([".."] + parts[-3:])
    return tuple(parts)

@lru_cache(maxsize=128)
def colorize_path(parts: tuple[str, ...], is_active: bool) -> str:
    color_hex = COLOR_ACTIVE_PATH if is_active else COLOR_INACTIVE_PATH
    kitty_color = f"_{color_hex.lstrip('#')}"
    # 统一路径颜色，不再使用分散的彩虹色
    sep = "{fmt.fg.tab}/"
    return f"{{fmt.fg.{kitty_color}}}" + sep.join(parts) + "{fmt.fg.tab}"

@lru_cache(maxsize=1)
def load_icons():
    # 保持你原有的逻辑，读取 .dotfiles/kitty/nerd-font-icons.yml
    icons = {}
    config_path = Path.home() / ".dotfiles/kitty/nerd-font-icons.yml"
    if not config_path.exists():
        # 如果找不到文件，提供几个基础图标回退
        return {"nvim": "", "zsh": "", "bash": "", "ssh": "󰣀"}
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            in_icons_section = False
            for line in f:
                stripped = line.strip()
                if stripped == 'icons:':
                    in_icons_section = True
                    continue
                if in_icons_section and ':' in stripped:
                    parts = stripped.split(':', 1)
                    if len(parts) == 2:
                        key = parts[0].strip().strip('"\'')
                        value = parts[1].strip().strip('"\'')
                        icons[key] = value
        return icons
    except: return {}

def draw_tab(
    draw_data: DrawData, screen: Screen, tab: TabBarData,
    before: int, max_title_length: int, index: int, is_last: bool,
    extra_data: ExtraData,
) -> int:
    ta = TabAccessor(tab.tab_id)
    path_tuple = get_short_path(ta.active_wd)
    pwd = colorize_path(path_tuple, tab.is_active)

    icons = load_icons()
    # 增加图标颜色高亮
    raw_icon = icons.get(ta.active_exe, ta.active_exe)
    icon = f"{{fmt.fg._{COLOR_ICON.lstrip('#')}}}{raw_icon}{{fmt.fg.tab}}"
    
    # 序号显示
    idx_str = f" {index} "

    # 构造新的渲染模板
    new_draw_data = draw_data._replace(
        title_template=f"{{fmt.fg.tab}}{idx_str}{pwd} {icon} "
    )
    
    # 使用 powerline 模式渲染（这能完美解决你之前的背景色问题）
    return draw_tab_with_powerline(
        new_draw_data, screen, tab,
        before, max_title_length, index, is_last,
        extra_data)