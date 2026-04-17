return {
  "saghen/blink.cmp",
  opts = {
    -- Automatically insert the completion as you type
    completion = {
      list = {
        selection = {
          -- Set to false if you don't want the first item pre-selected automatically
          preselect = false,
          auto_insert = true, 
        },
      },
    },
    -- Configure keymaps for navigation and acceptance
    keymap = {
      -- Use the "super-tab" preset which handles snippets and fallbacks correctly
      preset = "super-tab",

      -- Explicitly map <Tab> and <S-Tab> to select and accept or navigate
      ["<Tab>"] = {
        function(cmp)
          if cmp.is_visible() then
            return cmp.select_and_accept()
          end
        end,
        "snippet_forward",
        "fallback",
      },
      ["<S-Tab>"] = {
        "select_prev",
        "snippet_backward",
        "fallback",
      },
    },
  },
}