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

      -- Explicitly map <Tab> and <S-Tab> to select next/previous items
      ["<Tab>"] = {
        "select_next", -- Select the next completion item or jump to the next snippet placeholder
      },
      ["<S-Tab>"] = {
        "select_prev", -- Select the previous completion item or jump to the previous snippet placeholder
      },
      -- Note: with "super-tab" preset, <Tab> automatically handles snippet forwarding, 
      -- accepting AI suggestions (if applicable), and falling back to a regular tab.
    },
  },
}