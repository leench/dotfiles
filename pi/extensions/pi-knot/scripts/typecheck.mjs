#!/usr/bin/env node
/**
 * 用“当前安装的 Pi”的真实类型声明做类型检查。
 *
 * 为什么不把宿主安装为 runtime dependencies（只做 peer 声明）：
 * - 运行时宿主包由 Pi 通过虚拟模块提供，插件不能捆绑另一份 Pi；
 * - 类型检查只需要一个类型入口，路径在这里发现，不写进受管的 tsconfig。
 *
 * 查找顺序：
 * 1. `PI_KNOT_HOST_PACKAGE` 显式指定 @earendil-works/pi-coding-agent 目录；
 * 2. 正常模块解析（宿主作为本地 dev 依赖安装时）；
 * 3. Pi 托管安装布局：<agentDir>/install/current-version +
 *    releases/<version>/node_modules/@earendil-works/pi-coding-agent；
 * 4. 从 `pi` 可执行文件的真实路径向上查找。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromPlugin = createRequire(join(pluginDir, "package.json"));

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function inspectPackage(packageDir) {
  if (!packageDir) {
    return undefined;
  }
  const manifest = readJson(join(packageDir, "package.json"));
  if (!manifest || manifest.name !== HOST_PACKAGE) {
    return undefined;
  }
  const entry =
    typeof manifest.types === "string"
      ? manifest.types
      : typeof manifest.typings === "string"
        ? manifest.typings
        : "dist/index.d.ts";
  const typesFile = resolve(packageDir, entry);
  if (!existsSync(typesFile)) {
    return undefined;
  }
  return { dir: packageDir, version: manifest.version ?? "unknown", typesFile };
}

function fromModuleResolution() {
  try {
    const resolved = requireFromPlugin.resolve(HOST_PACKAGE);
    let dir = dirname(resolved);
    for (let depth = 0; depth < 6 && dir !== dirname(dir); depth += 1) {
      const host = inspectPackage(dir);
      if (host) {
        return host;
      }
      dir = dirname(dir);
    }
  } catch {
    // 未安装宿主包，继续用 Pi 的安装布局查找。
  }
  return undefined;
}

function agentDir() {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!override) {
    return join(homedir(), ".pi", "agent");
  }
  return override.replace(/^~(?=$|\/)/, homedir());
}

function fromManagedInstall() {
  const installDir = join(agentDir(), "install");
  const candidates = [];
  const currentFile = join(installDir, "current-version");
  if (existsSync(currentFile)) {
    candidates.push(readFileSync(currentFile, "utf8").trim());
  }
  const releasesDir = join(installDir, "releases");
  if (existsSync(releasesDir)) {
    const releases = readdirSync(releasesDir).sort((left, right) =>
      right.localeCompare(left, "en", { numeric: true }),
    );
    candidates.push(...releases);
  }
  for (const version of candidates) {
    const host = inspectPackage(join(installDir, "releases", version, "node_modules", ...HOST_PACKAGE.split("/")));
    if (host) {
      return host;
    }
  }
  return undefined;
}

function fromPiBinary() {
  let binary;
  try {
    binary = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
  if (!binary) {
    return undefined;
  }
  let dir;
  try {
    dir = dirname(realpathSync(binary));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 8 && dir !== dirname(dir); depth += 1) {
    const host = inspectPackage(join(dir, ...HOST_PACKAGE.split("/")));
    if (host) {
      return host;
    }
    const nested = inspectPackage(join(dir, "node_modules", ...HOST_PACKAGE.split("/")));
    if (nested) {
      return nested;
    }
    dir = dirname(dir);
  }
  return undefined;
}

function findHost() {
  const explicit = process.env.PI_KNOT_HOST_PACKAGE?.trim();
  if (explicit) {
    const host = inspectPackage(resolve(explicit));
    if (!host) {
      fail(`PI_KNOT_HOST_PACKAGE 不是有效的 Pi 宿主包目录：${explicit}`);
    }
    return { ...host, source: "环境变量 PI_KNOT_HOST_PACKAGE" };
  }
  for (const [source, finder] of [
    ["本地模块解析", fromModuleResolution],
    ["Pi 托管安装", fromManagedInstall],
    ["pi 可执行文件", fromPiBinary],
  ]) {
    const host = finder();
    if (host) {
      return { ...host, source };
    }
  }
  fail(
    [
      `找不到 Pi 宿主包 ${HOST_PACKAGE}。`,
      "请确认 Pi 已安装（`pi --version`），或显式指定：",
      `  PI_KNOT_HOST_PACKAGE=/path/to/node_modules/${HOST_PACKAGE} npm run typecheck`,
    ].join("\n"),
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const tsc = join(pluginDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
if (!existsSync(tsc)) {
  fail("找不到 typescript：请先在插件目录运行 `npm ci`（devDependencies 包含 typescript）。");
}

const host = findHost();
const configDir = join(pluginDir, "node_modules", ".pi-knot-typecheck");
const configPath = join(configDir, "tsconfig.json");
const toConfigPath = (target) => relative(configDir, target).split("\\").join("/");

mkdirSync(configDir, { recursive: true });
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      extends: toConfigPath(join(pluginDir, "tsconfig.json")),
      compilerOptions: {
        // 只在这个临时配置里指向已安装宿主的类型入口；受管 tsconfig 不写机器路径。
        paths: { [HOST_PACKAGE]: [host.typesFile] },
      },
      include: [toConfigPath(join(pluginDir, "index.ts")), toConfigPath(join(pluginDir, "src", "**", "*.ts"))],
    },
    null,
    2,
  )}\n`,
);

console.log(`Pi 宿主类型：${HOST_PACKAGE}@${host.version}（${host.source}）`);
console.log(`             ${host.dir}`);

let exitCode = 0;
try {
  execFileSync(tsc, ["-p", configPath], { stdio: "inherit", cwd: pluginDir });
} catch {
  exitCode = 1;
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

if (exitCode === 0) {
  console.log(`类型检查通过：tsc ${readTscVersion()} + Pi ${host.version}`);
} else {
  console.error("类型检查失败");
}
process.exit(exitCode);

function readTscVersion() {
  const version = readJson(join(pluginDir, "node_modules", "typescript", "package.json"))?.version;
  return typeof version === "string" ? version : "(unknown)";
}
