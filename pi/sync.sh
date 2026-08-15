#!/usr/bin/env bash

set -euo pipefail

PI_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME:?HOME is not set}"
PI_AGENT_DIR="$HOME_DIR/.pi/agent"
PI_EXT_DIR="$PI_AGENT_DIR/extensions"
GLOBAL_AGENTS_DIR="$HOME_DIR/.agents"
GLOBAL_SKILLS_DIR="$GLOBAL_AGENTS_DIR/skills"
SETTINGS_FILE="$PI_AGENT_DIR/settings.json"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
HOST_DEFAULTS="$PI_DIR/defaults/hosts/$HOSTNAME_SHORT.json"

MODE="${1:---update}"
case "$MODE" in
    --install|--update|--check|--apply-defaults)
        ;;
    -h|--help)
        cat <<'USAGE'
Usage: pi/sync.sh [--install|--update|--check|--apply-defaults]

  --install          preflight, migrate stable files, create links, install packages
  --update           preflight, repair links and reconcile packages (default)
  --check            read-only validation; reports local conflicts
  --apply-defaults   explicitly apply common + host defaults first
USAGE
        exit 0
        ;;
    *)
        echo "Unknown mode: $MODE" >&2
        exit 2
        ;;
esac

CHECK_ONLY=0
if [[ "$MODE" == "--check" ]]; then
    CHECK_ONLY=1
fi

BACKUP_DIR="${PI_SYNC_BACKUP_ROOT:-$HOME_DIR/pi-backups}/pi-sync-$(date +%Y%m%d-%H%M%S)"
BACKUP_READY=0
CHECK_FAILURE=0

log() {
    printf '[pi-sync] %s\n' "$*"
}

warn() {
    printf '[pi-sync][WARN] %s\n' "$*" >&2
}

fail() {
    printf '[pi-sync][ERROR] %s\n' "$*" >&2
    exit 1
}

prepare_backup() {
    if [[ "$BACKUP_READY" -eq 0 ]]; then
        mkdir -p "$BACKUP_DIR"
        chmod 700 "$BACKUP_DIR"
        BACKUP_READY=1
        log "本次变更备份目录：$BACKUP_DIR"
    fi
}

backup_copy() {
    local target="$1"
    local label="$2"
    [[ -e "$target" || -L "$target" ]] || return 0
    prepare_backup
    mkdir -p "$BACKUP_DIR/$(dirname "$label")"
    cp -a -- "$target" "$BACKUP_DIR/$label"
}

backup_move() {
    local target="$1"
    local label="$2"
    [[ -e "$target" || -L "$target" ]] || return 0
    prepare_backup
    mkdir -p "$BACKUP_DIR/$(dirname "$label")"
    mv -- "$target" "$BACKUP_DIR/$label"
}

check_problem() {
    CHECK_FAILURE=1
    warn "$*"
}

preflight_file() {
    local source="$1"
    local target="$2"
    local label="$3"

    [[ -f "$source" ]] || fail "源文件不存在：$source"
    [[ -e "$target" || -L "$target" ]] || return 0

    if [[ -L "$target" ]]; then
        if [[ "$(readlink -f "$target")" == "$(readlink -f "$source")" ]]; then
            return 0
        fi
        check_problem "本机 symlink 指向其他位置（不会自动替换）：$label -> $target"
        return 0
    fi

    if [[ -f "$target" ]] && cmp -s "$source" "$target"; then
        return 0
    fi
    check_problem "本机文件与 dotfiles 不一致（不会自动纳入或覆盖）：$label -> $target"
}

preflight_dir_contents() {
    local source="$1"
    local target="$2"
    local label="$3"
    local item rel source_item

    [[ -d "$source" ]] || fail "源目录不存在：$source"
    [[ -d "$target" && ! -L "$target" ]] || return 0

    while IFS= read -r -d '' item; do
        rel="${item#"$target/"}"
        source_item="$source/$rel"

        if [[ -d "$item" && ! -L "$item" ]]; then
            if [[ ! -d "$source_item" || -L "$source_item" ]]; then
                check_problem "本机目录未纳入 dotfiles（不会自动复制）：$label/$rel"
            fi
            continue
        fi

        if [[ ! -e "$source_item" && ! -L "$source_item" ]]; then
            check_problem "本机文件未纳入 dotfiles（不会自动复制）：$label/$rel"
        elif [[ -f "$item" && -f "$source_item" && ! -L "$item" && ! -L "$source_item" ]]; then
            if ! cmp -s "$item" "$source_item"; then
                check_problem "本机文件与 dotfiles 不一致（不会自动覆盖）：$label/$rel"
            fi
        else
            check_problem "本机路径类型与 dotfiles 不一致：$label/$rel"
        fi
    done < <(find "$target" -mindepth 1 -print0)
}

preflight_extensions() {
    local source="$PI_DIR/extensions"
    local target="$PI_EXT_DIR"
    local target_file rel source_file

    [[ -d "$source" ]] || fail "源目录不存在：$source"
    [[ -d "$target" && ! -L "$target" ]] || return 0

    while IFS= read -r -d '' source_file; do
        rel="${source_file#"$source/"}"
        preflight_file "$source_file" "$target/$rel" "extensions/$rel"
    done < <(find "$source" -type f \
        -not -path '*/node_modules/*' \
        -not -path '*/logs/*' \
        -not -path '*/.git' \
        -not -path '*/.git/*' \
        -print0)

    while IFS= read -r -d '' target_file; do
        rel="${target_file#"$target/"}"
        case "$rel" in
            */node_modules/*|*/logs/*|*/.git|*/.git/*)
                continue
                ;;
        esac
        source_file="$source/$rel"
        if [[ ! -f "$source_file" ]]; then
            check_problem "本机 extension 文件未纳入 dotfiles（不会自动复制）：extensions/$rel"
        fi
    done < <(find "$target" -type f -print0)
}

preflight_static_layout() {
    preflight_file "$PI_DIR/AGENTS.md" "$PI_AGENT_DIR/AGENTS.md" "agent-AGENTS.md"
    preflight_dir_contents "$PI_DIR/agents" "$PI_AGENT_DIR/agents" "agents"
    preflight_dir_contents "$PI_DIR/prompts" "$PI_AGENT_DIR/prompts" "prompts"
    preflight_dir_contents "$PI_DIR/skills" "$GLOBAL_SKILLS_DIR" "skills"
    preflight_extensions
    preflight_file \
        "$PI_DIR/remote-skills/agent-network/SKILL.md" \
        "$HOME_DIR/.pi/remote/skills/agent-network/SKILL.md" \
        "remote-skills/agent-network/SKILL.md"
}

ensure_dir_link() {
    local source="$1"
    local target="$2"
    local label="$3"

    [[ -d "$source" ]] || fail "源目录不存在：$source"

    if [[ -L "$target" ]]; then
        if [[ "$(readlink -f "$target")" == "$(readlink -f "$source")" ]]; then
            return 0
        fi
        if [[ "$CHECK_ONLY" -eq 1 ]]; then
            check_problem "symlink 指向错误：$target"
            return 0
        fi
        backup_move "$target" "$label"
    elif [[ -e "$target" ]]; then
        if [[ "$CHECK_ONLY" -eq 1 ]]; then
            log "目录内容可迁移，待建立 symlink：$target"
            return 0
        fi
        backup_move "$target" "$label"
    elif [[ "$CHECK_ONLY" -eq 1 ]]; then
        log "待建立目录 symlink：$target"
        return 0
    fi

    if [[ "$CHECK_ONLY" -eq 0 ]]; then
        mkdir -p "$(dirname "$target")"
        ln -s -- "$source" "$target"
        log "建立目录 symlink：$target -> $source"
    fi
}

ensure_file_link() {
    local source="$1"
    local target="$2"
    local label="$3"

    [[ -f "$source" ]] || fail "源文件不存在：$source"

    if [[ -L "$target" ]]; then
        if [[ "$(readlink -f "$target")" == "$(readlink -f "$source")" ]]; then
            return 0
        fi
        if [[ "$CHECK_ONLY" -eq 1 ]]; then
            check_problem "文件 symlink 指向错误：$target"
            return 0
        fi
        backup_move "$target" "$label"
    elif [[ -e "$target" ]]; then
        if [[ "$CHECK_ONLY" -eq 1 ]]; then
            log "文件内容可迁移，待建立 symlink：$target"
            return 0
        fi
        backup_move "$target" "$label"
    elif [[ "$CHECK_ONLY" -eq 1 ]]; then
        log "待建立文件 symlink：$target"
        return 0
    fi

    if [[ "$CHECK_ONLY" -eq 0 ]]; then
        mkdir -p "$(dirname "$target")"
        ln -s -- "$source" "$target"
        log "建立文件 symlink：$target -> $source"
    fi
}

copy_if_missing() {
    local source="$1"
    local target="$2"
    [[ -f "$source" ]] || fail "源文件不存在：$source"

    if [[ -e "$target" || -L "$target" ]]; then
        return 0
    fi
    if [[ "$CHECK_ONLY" -eq 1 ]]; then
        log "待初始化本机文件：$target"
        return 0
    fi
    mkdir -p "$(dirname "$target")"
    cp -a -- "$source" "$target"
    log "初始化本机文件：$target"
}

ensure_static_layout() {
    if [[ "$CHECK_ONLY" -eq 0 ]]; then
        mkdir -p "$PI_AGENT_DIR" "$PI_EXT_DIR" "$GLOBAL_AGENTS_DIR" "$HOME_DIR/.pi/remote/skills"
        chmod 700 "$PI_AGENT_DIR" "$GLOBAL_AGENTS_DIR"
    else
        [[ -d "$PI_AGENT_DIR" ]] || check_problem "缺少目录：$PI_AGENT_DIR"
        [[ -d "$PI_EXT_DIR" ]] || check_problem "缺少目录：$PI_EXT_DIR"
        [[ -d "$GLOBAL_AGENTS_DIR" ]] || check_problem "缺少目录：$GLOBAL_AGENTS_DIR"
    fi

    ensure_file_link "$PI_DIR/AGENTS.md" "$PI_AGENT_DIR/AGENTS.md" "agent-AGENTS.md"
    ensure_dir_link "$PI_DIR/agents" "$PI_AGENT_DIR/agents" "agent-agents"
    ensure_dir_link "$PI_DIR/prompts" "$PI_AGENT_DIR/prompts" "agent-prompts"
    ensure_dir_link "$PI_DIR/skills" "$GLOBAL_SKILLS_DIR" "global-skills"

    while IFS= read -r -d '' source_file; do
        local rel target_file label
        rel="${source_file#"$PI_DIR/extensions/"}"
        target_file="$PI_EXT_DIR/$rel"
        label="extensions/$rel"
        ensure_file_link "$source_file" "$target_file" "$label"
    done < <(find "$PI_DIR/extensions" -type f \
        -not -path '*/node_modules/*' \
        -not -path '*/logs/*' \
        -not -path '*/.git' \
        -not -path '*/.git/*' \
        -print0)

    ensure_file_link \
        "$PI_DIR/remote-skills/agent-network/SKILL.md" \
        "$HOME_DIR/.pi/remote/skills/agent-network/SKILL.md" \
        "remote-skills/agent-network/SKILL.md"

    copy_if_missing "$PI_DIR/remote-pi/config.json" "$HOME_DIR/.pi/remote-pi/config.json"
    copy_if_missing "$PI_DIR/pi-atelier.json" "$PI_AGENT_DIR/pi-atelier.json"
    copy_if_missing "$PI_DIR/skill-lock.json" "$GLOBAL_AGENTS_DIR/.skill-lock.json"
}

load_package_specs() {
    mapfile -t PACKAGE_SPECS < <(awk '
        /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
        { sub(/[[:space:]]+#.*$/, ""); print }
    ' "$PI_DIR/packages.txt")
}

package_json() {
    printf '%s\n' "${PACKAGE_SPECS[@]-}" | jq -R -s '
        split("\n") | map(select(length > 0))
    '
}

merge_managed_packages() {
    local settings="$1"
    local managed_json tmp
    managed_json="$(package_json)"
    tmp="$(mktemp "$settings.tmp.XXXXXX")"

    if ! jq --argjson managed "$managed_json" '
        def source:
            if type == "string" then . else (.source // "") end;
        def package_id:
            source
            | if startswith("npm:@") then
                  (try capture("^(?<id>npm:@[^/]+/[^@]+)").id catch .)
              elif startswith("npm:") then
                  (try capture("^(?<id>npm:[^@]+)").id catch .)
              else .
              end;
        ($managed | map({raw: ., id: (. | package_id)})) as $managed_entries
        | .packages = (
            [(.packages // [])[] as $p
             | ($p | package_id) as $id
             | select(all($managed_entries[]; .id != $id))
             | $p]
            + ($managed_entries | map(.raw))
          )
    ' "$settings" > "$tmp"; then
        rm -f -- "$tmp"
        fail "无法合并 settings.json 的 packages 字段"
    fi

    chmod 600 "$tmp"
    mv -- "$tmp" "$settings"
}

create_settings_if_missing() {
    if [[ -e "$SETTINGS_FILE" || -L "$SETTINGS_FILE" ]]; then
        jq empty "$SETTINGS_FILE" >/dev/null 2>&1 \
            || fail "现有 settings.json 不是合法 JSON，已停止且未覆盖：$SETTINGS_FILE"
        return 0
    fi

    if [[ "$CHECK_ONLY" -eq 1 ]]; then
        check_problem "缺少 settings.json：$SETTINGS_FILE"
        return 0
    fi

    local host_file="$HOST_DEFAULTS"
    local tmp
    [[ -f "$host_file" ]] || host_file="/dev/null"
    tmp="$(mktemp "$PI_AGENT_DIR/settings.json.tmp.XXXXXX")"
    jq -s '.[0] * (.[1] // {})' "$PI_DIR/defaults/common.json" "$host_file" > "$tmp"
    chmod 600 "$tmp"
    mv -- "$tmp" "$SETTINGS_FILE"
    log "首次创建 settings.json（仅使用 defaults）"
}

apply_defaults() {
    [[ "$MODE" == "--apply-defaults" ]] || return 0
    [[ "$CHECK_ONLY" -eq 0 ]] || return 0

    local host_file="$HOST_DEFAULTS"
    local tmp
    [[ -f "$host_file" ]] || host_file="/dev/null"
    backup_copy "$SETTINGS_FILE" "agent/settings.json.before-apply-defaults"
    tmp="$(mktemp "$SETTINGS_FILE.tmp.XXXXXX")"
    jq --slurpfile common "$PI_DIR/defaults/common.json" \
       --slurpfile host "$host_file" \
       '. * $common[0] * ($host[0] // {})' \
       "$SETTINGS_FILE" > "$tmp"
    chmod 600 "$tmp"
    mv -- "$tmp" "$SETTINGS_FILE"
    log "已显式应用 common + host defaults"
}

check_packages() {
    local spec
    for spec in "${PACKAGE_SPECS[@]-}"; do
        if ! jq -e --arg spec "$spec" '
            any((.packages // [])[];
                (type == "string" and . == $spec)
                or (type == "object" and .source == $spec))
        ' "$SETTINGS_FILE" >/dev/null; then
            check_problem "settings.json 缺少受管 package：$spec"
        fi
    done
}

reconcile_packages() {
    [[ "$CHECK_ONLY" -eq 0 ]] || { check_packages; return 0; }
    [[ "${PI_SYNC_SKIP_PACKAGES:-0}" == "1" ]] && {
        warn "PI_SYNC_SKIP_PACKAGES=1，跳过 Pi package reconcile"
        return 0
    }

    local pi_bin
    pi_bin="${PI_BIN:-$(command -v pi || true)}"
    [[ -n "$pi_bin" ]] || fail "找不到 pi 命令，无法 reconcile packages"

    backup_copy "$SETTINGS_FILE" "agent/settings.json.before-package-sync"
    merge_managed_packages "$SETTINGS_FILE"
    log "已仅更新 settings.json 的 packages 字段"
    "$pi_bin" update --extensions
}

ensure_dependency_bridge() {
    local source_node_modules="$1"
    local target_node_modules="$2"

    if [[ -L "$source_node_modules" ]]; then
        if [[ "$(readlink -f "$source_node_modules")" == "$(readlink -f "$target_node_modules")" ]]; then
            return 0
        fi
        if [[ "$CHECK_ONLY" -eq 1 ]]; then
            check_problem "extension node_modules bridge 指向错误：$source_node_modules"
        else
            fail "extension node_modules bridge 指向错误，未自动覆盖：$source_node_modules"
        fi
        return 0
    fi

    if [[ -e "$source_node_modules" ]]; then
        # A manually installed source-side dependency tree is usable; do not
        # delete or move it automatically.
        warn "保留 dotfiles 中已有的 extension node_modules：$source_node_modules"
        return 0
    fi

    if [[ "$CHECK_ONLY" -eq 1 ]]; then
        check_problem "缺少 extension node_modules bridge：$source_node_modules"
        return 0
    fi

    ln -s "$target_node_modules" "$source_node_modules"
    log "建立 node_modules bridge：$source_node_modules -> $target_node_modules"
}

reconcile_custom_dependencies() {
    local npm_bin
    npm_bin="${NPM_BIN:-$(command -v npm || true)}"
    [[ -n "$npm_bin" ]] || fail "找不到 npm 命令"

    while IFS= read -r -d '' lockfile; do
        local rel ext_rel target_dir source_node_modules target_node_modules
        rel="${lockfile#"$PI_DIR/extensions/"}"
        ext_rel="${rel%/package-lock.json}"
        target_dir="$PI_EXT_DIR/$ext_rel"
        source_node_modules="$PI_DIR/extensions/$ext_rel/node_modules"
        target_node_modules="$target_dir/node_modules"

        if [[ ! -d "$target_node_modules" ]]; then
            if [[ "$CHECK_ONLY" -eq 1 ]]; then
                check_problem "缺少自研 extension 依赖：$target_node_modules"
                continue
            else
                log "执行 npm ci：$target_dir"
                (cd "$target_dir" && "$npm_bin" ci)
            fi
        fi

        ensure_dependency_bridge "$source_node_modules" "$target_node_modules"
    done < <(find "$PI_DIR/extensions" -type f -name package-lock.json \
        -not -path '*/node_modules/*' \
        -not -path '*/.git' \
        -not -path '*/.git/*' \
        -print0)
}

load_package_specs
[[ -f "$PI_DIR/skill-lock.json" ]] || fail "缺少 skill-lock.json 源文件"
preflight_static_layout
if [[ "$CHECK_ONLY" -eq 0 && "$CHECK_FAILURE" -ne 0 ]]; then
    fail "预检发现本机配置与 dotfiles 有差异；未修改任何目标文件。请人工审查后再同步。"
fi
ensure_static_layout
create_settings_if_missing
apply_defaults

if [[ "$CHECK_ONLY" -eq 1 ]]; then
    check_packages
else
    reconcile_packages
fi
reconcile_custom_dependencies

if [[ "$CHECK_ONLY" -eq 1 && "$CHECK_FAILURE" -ne 0 ]]; then
    exit 1
fi

log "同步完成"
if [[ "$BACKUP_READY" -eq 1 ]]; then
    log "本次局部备份保留于：$BACKUP_DIR"
fi
