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

test("uses enabled Shadow defaults when no config file exists", () => {
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
  assert.match(loaded.error ?? "", /Shadow 已关闭/);
});

test("fails closed for unsupported modes and out-of-range values", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ mode: "suggest", timeoutMs: 60_000 }), "utf8");

  const loaded = loadRouterConfig(path);
  assert.equal(loaded.config.enabled, false);
  assert.match(loaded.error ?? "", /配置无效/);
});
