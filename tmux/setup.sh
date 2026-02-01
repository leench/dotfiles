#!/bin/bash

# 定义 TPM 安装目录
TPM_DIR="$HOME/.tmux/plugins/tpm"

echo "正在检查 Tmux Plugin Manager (TPM)..."

if [ ! -d "$TPM_DIR" ]; then
    echo "TPM 未找到，正在安装..."
    git clone https://github.com/tmux-plugins/tpm "$TPM_DIR"
    echo "TPM 安装完成！"
else
    echo "TPM 已安装。"
fi

echo ""
echo "配置完成！请执行以下步骤加载插件："
echo "1. 启动 tmux (如果您已经在 tmux 中，请按 'Prefix + R' 重载配置)"
echo "2. 按下 'Prefix + I' (即 Ctrl+a, 然后按大写的 I)"
echo "   这将自动下载并安装配置文件中列出的所有插件。"
