-- ~/.config/nvim/lua/plugins/example.lua
return {
  {
    "folke/snacks.nvim",
    opts = {
      image = {
        enabled = true,
        doc = {
          inline = true, -- 在文档中内联显示图片
          float = true,  -- 悬浮窗显示图片
          max_width = 80,
          max_height = 40,
        },
      },
    },
  },
}
