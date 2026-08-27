# Pi configuration

This package is deployed by `sync.sh`, not by Stow's default directory
mapping. Stable agents, prompts, skills, extension sources and subagent settings
are linked into Pi's user directories. The main
`settings.json` remains local, but every field explicitly present in
`defaults/common.json` is synchronized into it during `sync.sh --update`.
The proxy rules are kept separately in `proxy-router.json` and linked to
`~/.pi/agent/proxy-router.json`, so they can be versioned without mixing them
with Pi's runtime settings. Credentials, sessions and other runtime state
remain local. Packages and extensions present only on the local machine are
preserved. Extension
`node_modules` stay under `~/.pi/agent/extensions` and receive an ignored
source-side bridge symlink so Node can resolve dependencies through the
linked source path.

`extensions/pi-proxy-router` and `extensions/pi-time-up` are Git submodules
of their standalone repositories. Edit an extension directly in its submodule
directory, then commit/push the extension repository; after updating its submodule
pointer, commit the pointer in this dotfiles repository as well. Clone this
repository with `--recurse-submodules`, or run `git submodule update --init
--recursive` before `sync.sh`.

- `packages.txt`: pinned third-party Pi packages
- `proxy-router.json`: versioned model/auth proxy rules, linked independently
- `agents/`: synchronized custom subagent definitions
- `extensions/subagent/config.json`: synchronized pi-subagents runtime config
- `defaults/common.json`: explicitly synchronized common settings fields, including builtin-agent policy
- `defaults/hosts/`: optional host-local defaults, applied only explicitly
- `sync.sh --install`: initial migration/install
- `sync.sh --update`: repair links, synchronize common fields, and reconcile packages
- `sync.sh --check`: read-only validation, including common field drift
- `sync.sh --apply-defaults`: explicit common + host settings merge
- `SETUP-OTHER-COMPUTER.md`: 给其他电脑上的 coding agent 执行的安全部署手册

在已有 Pi 的电脑上首次运行前，先备份 `~/.pi` 和 `~/.agents`。同步会先比较本机受管目录；如果发现本机新增文件或同名文件内容不同，会直接停止，不会自动把文件写入 dotfiles，也不会替换本机目录。人工审查并把需要保留的内容复制到本包后，再重新运行 `./install.sh pi`。
