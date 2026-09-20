#!/usr/bin/env node
'use strict';

/*
 * resources 资产安装器(双模式,均在 resources/ 侧运行):
 *
 *   node resources/scripts/install.js              # 模式一·预置:把工具下载到 resources/.tools/
 *                                                  #   此后 resources/ 连工具完全自包含,拷贝其内容
 *                                                  #   到新项目根即生效,新项目连首次下载都免了
 *   node resources/scripts/install.js <目标项目根>  # 模式二·预置+推送:先确保工具就绪,再把 resources/
 *                                                  #   下的全部文件和文件夹(含隐藏的 .zcode/ 与 .tools/)
 *                                                  #   拷贝到目标项目根
 *
 * 新项目的生效方式永远是"拷贝 resources/ 的内容到项目根 + 重开 ZCode 会话",不需要在
 * 新项目里跑任何命令;随资产下发的本脚本在目标项目里同样可用(无参=补齐该项目 .tools)。
 *
 * 下载说明(预置/首次检查都可能触发,约 70MB 到 .tools/,之后离线复用):
 *   - 下载哪些版本由同目录 hook-config.json 决定:formatter.version(google-java-format)、
 *     convention.version(PMD)、deepScan.spotbugsVersion / findsecbugsVersion;改版本后重跑
 *     本命令即自动下载新版本(.tools/ 按版本分目录,旧版本保留可回退)。
 *   - 下载过程会实时打印每个候选地址;失败时错误信息带全部候选 URL 与精确存放路径,
 *     可照抄用浏览器手动下载放到对应位置,重跑即跳过下载。
 *   - google-java-format 从 Maven Central 下载,稳定;PMD 发行包只有 GitHub Releases 一个
 *     渠道,受限网络可能超时:自动重试,支持 HTTPS_PROXY 代理。
 *
 * 安全阀:上级目录必须带资产标记(.zcode/config.json + scripts/hook-runner.js),防止孤儿
 *   脚本把无关目录当资产;带参模式下目标不得包含 resources/ 自身,且当前目录不能是已
 *   部署的项目根(防把整个项目误推给别的项目)。
 * 注意:刻意不用 fs.cpSync —— node 25 实测其在中文路径下原生崩溃(静默退出),
 *   copyFileSync 同场景正常,故手写递归拷贝。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ASSETS_ROOT = path.resolve(__dirname, '..'); // resources/
const RUNNER = path.join(__dirname, 'hook-runner.js');
const MARKERS = ['.zcode/config.json', 'scripts/hook-runner.js'];
const PROJECT_INDICATORS = ['src', 'pom.xml', 'build.gradle', 'build.gradle.kts', '.git'];

try {
  main();
} catch (e) {
  console.error(`[install] 失败: ${e.message}`);
  process.exit(1);
}

function main() {
  assertAssetsComplete();
  const target = process.argv[2] ? path.resolve(process.argv[2]) : null;

  // 工具预置复用 runner 的 warmup:同一份下载/解压逻辑,不维护两套
  console.log('[install] 预置工具(已就绪则秒过)...');
  const warmed = spawnSync(process.execPath, [RUNNER, 'warmup'], { stdio: 'inherit' });
  if (warmed.status !== 0) {
    throw new Error(`工具预置失败(exit ${warmed.status});失败详情含手动下载地址与存放路径。工具版本在同目录 hook-config.json(formatter.version / convention.version / deepScan.*),改版本后重跑本命令即自动下载新版本`);
  }
  if (!target) {
    console.log('[install] 预置完成:resources/ 已自包含(含 .tools/),拷贝其内容到新项目根即用。');
    return;
  }

  assertSourceIsAssetRoot();
  assertTargetOutsideAssets(target);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(ASSETS_ROOT, { withFileTypes: true })) {
    // resources/.gitignore 是 warmup 自愈生成的内部文件,不随推送覆盖目标已有的 .gitignore
    // (目标侧的忽略项由下方 ensureGitignore 合并追加)
    if (entry.name === '.gitignore') continue;
    copyTree(path.join(ASSETS_ROOT, entry.name), path.join(target, entry.name));
    console.log(`[install] 已安装: ${entry.name}${entry.isDirectory() ? '/' : ''}`);
  }
  ensureGitignore(target);
  console.log(`[install] 完成: ${target}`);
  console.log('[install] 下一步: 用 ZCode 打开该目录(重开会话加载 hook),写一个违规 .java 验证。');
}

function assertAssetsComplete() {
  const missing = MARKERS.filter(m => !fs.existsSync(path.join(ASSETS_ROOT, m)));
  if (missing.length > 0) {
    throw new Error(`上级目录不是完整的 resources 资产(缺 ${missing.join('、')});请从 resources/scripts/ 运行`);
  }
}

// 推送是"以 resources/ 为源"的动作:若当前目录像已部署的项目根(有 src/pom 等),
// 说明脚本正跑在目标项目里,把整个项目拷给别的项目几乎必是误用
function assertSourceIsAssetRoot() {
  const hit = PROJECT_INDICATORS.filter(m => fs.existsSync(path.join(ASSETS_ROOT, m)));
  if (hit.length > 0) {
    throw new Error(`当前 resources/ 含项目特征(${hit.join('、')}),像已部署的项目根;推送请从模板的 resources/scripts/ 发起`);
  }
}

function assertTargetOutsideAssets(target) {
  const rel = path.relative(target, ASSETS_ROOT);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('目标目录包含 resources/ 自身(疑似模板根),拒绝安装');
  }
}

function copyTree(from, to) {
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
  } else {
    fs.copyFileSync(from, to);
  }
}

function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/).includes('.tools/')) return;
  fs.appendFileSync(file, `${fs.existsSync(file) ? '\n' : ''}# quality-hook 工具下载缓存\n.tools/\n`);
}
