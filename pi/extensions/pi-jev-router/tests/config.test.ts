import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_ROUTER_CONFIG,
  loadRouterConfig,
  saveRouterConfig,
} from "../src/config.ts";

const temporaryDirectories: string[] = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-jev-router-config-"));
  temporaryDirectories.push(directory);
  return join(directory, "jev-router.json");
}

test("uses enabled Suggest defaults when no config file exists", () => {
  const loaded = loadRouterConfig(configPath());
  assert.deepEqual(loaded.config, DEFAULT_ROUTER_CONFIG);
  assert.equal(loaded.error, undefined);
});

test("persists the enabled switch and reads the full config back", () => {
  const path = configPath();
  const config = { ...DEFAULT_ROUTER_CONFIG, enabled: false };
  saveRouterConfig(path, config);
  assert.deepEqual(loadRouterConfig(path), { config });
});

test("fails closed when the config cannot be parsed", () => {
  const path = configPath();
  writeFileSync(path, "not json", "utf8");

  const loaded = loadRouterConfig(path);
  assert.equal(loaded.config.enabled, false);
  assert.match(loaded.error ?? "", /Jev 路由已关闭/);
});

test("accepts HTTP and SOCKS proxy URLs", () => {
  for (const proxyUrl of [
    "http://127.0.0.1:7890",
    "https://proxy.example:8443",
    "socks5://127.0.0.1:1080",
    "socks5h://127.0.0.1:1080",
  ]) {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ ...DEFAULT_ROUTER_CONFIG, proxyUrl }), "utf8");
    assert.equal(loadRouterConfig(path).config.proxyUrl, proxyUrl);
  }
});

test("fails closed for unsupported or malformed proxy URLs", () => {
  for (const proxyUrl of ["ftp://proxy.example:21", "not a URL", "http://proxy.example/path"]) {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ ...DEFAULT_ROUTER_CONFIG, proxyUrl }), "utf8");

    const loaded = loadRouterConfig(path);
    assert.equal(loaded.config.enabled, false);
    assert.match(loaded.error ?? "", /配置无效/);
  }
});

test("accepts the Shadow mode for explicit comparison", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ ...DEFAULT_ROUTER_CONFIG, mode: "shadow" }), "utf8");

  const loaded = loadRouterConfig(path);
  assert.equal(loaded.config.mode, "shadow");
  assert.equal(loaded.config.enabled, true);
});

test("fails closed for unsupported modes and out-of-range values", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ mode: "invalid", timeoutMs: 60_000 }), "utf8");

  const loaded = loadRouterConfig(path);
  assert.equal(loaded.config.enabled, false);
  assert.match(loaded.error ?? "", /配置无效/);
});
