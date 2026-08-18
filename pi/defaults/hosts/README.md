# Pi 主机专属 defaults

主机专属配置属于本机状态，不应提交到公共 dotfiles 仓库。同步脚本默认从以下路径读取当前 hostname 对应的文件：

```text
~/.pi/agent/host-defaults/<hostname>.json
```

可以复制本目录的 [`example.json`](./example.json) 作为起点：

```bash
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
mkdir -p "$HOME/.pi/agent/host-defaults"
cp pi/defaults/hosts/example.json \
  "$HOME/.pi/agent/host-defaults/$HOSTNAME_SHORT.json"
```

然后按本机情况修改代理地址和模型匹配规则。没有本机文件时，只使用公共的 `pi/defaults/common.json`。

`./pi/sync.sh --apply-defaults` 会显式应用公共 defaults 与本机 defaults；日常 `./pi/sync.sh --update` 会同步 `defaults/common.json` 中显式存在的字段，但不会应用 host defaults。不要把另一台电脑的主机配置复制回仓库。
