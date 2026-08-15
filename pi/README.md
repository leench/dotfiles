# Pi configuration

This package is deployed by `sync.sh`, not by Stow's default directory
mapping. Stable agents, prompts, skills and extension sources are linked into
Pi's user directories; settings and runtime state remain local.

- `packages.txt`: pinned third-party Pi packages
- `defaults/`: first-install settings only
- `sync.sh --install`: initial migration/install
- `sync.sh --update`: idempotent repair and package reconciliation
- `sync.sh --check`: read-only validation
- `sync.sh --apply-defaults`: explicit settings default merge
- `SETUP-OTHER-COMPUTER.md`: 给其他电脑上的 coding agent 执行的安全部署手册

在已有 Pi 的电脑上首次运行前，先备份 `~/.pi` 和 `~/.agents`。同步会先比较本机受管目录；如果发现本机新增文件或同名文件内容不同，会直接停止，不会自动把文件写入 dotfiles，也不会替换本机目录。人工审查并把需要保留的内容复制到本包后，再重新运行 `./install.sh pi`。
