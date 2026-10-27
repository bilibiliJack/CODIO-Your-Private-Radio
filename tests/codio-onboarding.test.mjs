import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import desktopOnboarding from "../desktop/codio-onboarding.cjs";

const dir = new URL("../.test-build/codio-onboarding/", import.meta.url);
const output = new URL("codio-onboarding.mjs", dir);
let api;

before(async () => {
  await mkdir(dir, { recursive: true });
  await build({ entryPoints: [new URL("../app/codio-onboarding.ts", import.meta.url).pathname.slice(1)], outfile: output.pathname.slice(1), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  api = await import(`${output.href}?${Date.now()}`);
});
after(async () => rm(dir, { recursive: true, force: true }));

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("a new user sees onboarding and a completed user does not", () => {
  assert.equal(api.readCodioOnboarding(storage()).completed, false);
  const saved = storage();
  api.saveCodioOnboarding(saved, false, false);
  assert.equal(api.readCodioOnboarding(saved).completed, true);
});

test("QQ and DeepSeek can be skipped independently or together", () => {
  for (const [qq, deepSeek] of [[true, false], [false, true], [true, true]]) {
    const saved = storage();
    api.saveCodioOnboarding(saved, qq, deepSeek);
    assert.deepEqual(api.readCodioOnboarding(saved), { version: 1, completed: true, qqSkipped: qq, deepSeekSkipped: deepSeek });
  }
});

test("desktop onboarding survives a fresh renderer origin and stores only non-sensitive state", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "codio-onboarding-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const saved = await desktopOnboarding.saveOnboardingState(userData, { version: 1, completed: true, qqSkipped: true, deepSeekSkipped: false, apiKey: "must-not-persist" });
  assert.deepEqual(saved, { version: 1, completed: true, qqSkipped: true, deepSeekSkipped: false });
  assert.deepEqual(await desktopOnboarding.readOnboardingState(userData), saved);
});

test("real bridge connection wins over an old skipped state", () => {
  assert.deepEqual(api.onboardingConnectionSummary(true, true, true, true), { qq: "connected", deepSeek: "connected" });
  assert.deepEqual(api.onboardingConnectionSummary(false, false, true, false), { qq: "skipped", deepSeek: "not_connected" });
});

test("onboarding persistence contains no API key, cookie, credential, or identity", () => {
  const saved = storage({ profile: "keep", history: "keep", qqCookie: "keep-outside-onboarding" });
  api.saveCodioOnboarding(saved, true, true);
  const raw = saved.values.get(api.CODIO_ONBOARDING_KEY);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["completed", "deepSeekSkipped", "qqSkipped", "version"].sort());
  assert.doesNotMatch(raw, /sk-|cookie|credential|userId|identity/i);
  assert.equal(saved.values.get("profile"), "keep");
  assert.equal(saved.values.get("history"), "keep");
  assert.equal(saved.values.get("qqCookie"), "keep-outside-onboarding");
});
