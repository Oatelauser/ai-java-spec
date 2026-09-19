#!/usr/bin/env bash
#
# 把模板里的项目级质量 hook 资产安装到一个新的 Java 项目,使其开箱即受增量质量约束。
#
# 用法:
#   bash /path/to/模板/scripts/init-java-project.sh /path/to/新项目
#
# 做三件事(仅此而已,不做代码生成):
#   1. 复制 .zcode/config.json(hook 挂载,ZCode 打开该项目目录即生效)
#   2. 复制 scripts/(hook-runner.js + hook-config.json + 预设)
#   3. 把 .tools/ 写进新项目 .gitignore(工具下载缓存,不入库)
#
# 之后用 ZCode 打开新项目目录,编辑 .java 文件即触发增量检查;首次触发会联网下载工具。

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "用法: bash $0 <新项目绝对路径>" >&2
  exit 1
fi

target=$1
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
template_root=$(cd "$script_dir/.." && pwd)

if [ ! -d "$target" ]; then
  echo "目标目录不存在,自动创建: $target"
  mkdir -p "$target"
fi

mkdir -p "$target/.zcode" "$target/scripts"
cp "$template_root/.zcode/config.json" "$target/.zcode/config.json"
cp "$script_dir/hook-runner.js" "$target/scripts/"
cp "$script_dir/hook-config.json" "$target/scripts/"
cp "$script_dir/hook-config.pmd6-p3c.json" "$target/scripts/" 2>/dev/null || true

if [ -f "$target/.gitignore" ] && ! grep -qx '.tools/' "$target/.gitignore"; then
  printf '\n# quality-hook 工具下载缓存\n.tools/\n' >> "$target/.gitignore"
elif [ ! -f "$target/.gitignore" ]; then
  printf '# quality-hook 工具下载缓存\n.tools/\n' > "$target/.gitignore"
fi

echo "已安装项目级质量 hook 到: $target"
echo "下一步:"
echo "  1. 预热(可选,推荐): cd \"$target\" && node scripts/hook-runner.js warmup   # 提前下载约 70MB 工具"
echo "  2. 用 ZCode 打开该目录(重开会话才会加载 hook),编辑任意 .java 文件验证触发(需 JAVA_HOME)。"
