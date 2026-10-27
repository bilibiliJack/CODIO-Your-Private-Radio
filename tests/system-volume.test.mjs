import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import { createSystemVolume, parseStatus } from "../desktop/system-volume.cjs";

const state = (volume = 42, muted = false) => ({ available: true, volume, muted });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class FakeHelper extends EventEmitter {
  constructor({ ready = true, onCommand } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.commands = [];
    this.killed = false;
    this.status = state();
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        input += chunk.toString();
        let end;
        while ((end = input.indexOf("\n")) !== -1) {
          const line = input.slice(0, end);
          input = input.slice(end + 1);
          this.commands.push(line);
          if (line === "quit") { this.emit("exit", 0); continue; }
          const [command, rawId, rawValue] = line.split(" ");
          const id = Number(rawId);
          if (onCommand) onCommand(this, command, id, Number(rawValue));
          else {
            if (command === "set") this.status = state(Number(rawValue), Number(rawValue) > 0 ? false : this.status.muted);
            if (command === "mute") this.status = state(this.status.volume, rawValue === "1");
            this.send({ type: "response", id, ...this.status });
          }
        }
        done();
      },
    });
    if (ready) queueMicrotask(() => this.send({ type: "ready", ...this.status }));
  }
  send(message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill() { this.killed = true; this.emit("exit", 0); }
}

function harness(t, helperOptions = {}, bridgeOptions = {}) {
  const children = [];
  const calls = [];
  const bridge = createSystemVolume({
    platform: "win32", helperScript: "# isolated helper", coalesceMs: 5,
    requestTimeoutMs: 100, startTimeoutMs: 100, retryMs: 0,
    spawnProcess: (executable, args, options) => {
      calls.push({ executable, args, options });
      const child = new FakeHelper(typeof helperOptions === "function" ? helperOptions(children.length) : helperOptions);
      children.push(child);
      return child;
    },
    ...bridgeOptions,
  });
  t.after(() => bridge.dispose());
  return { bridge, children, calls };
}

test("strict finite numeric bounds reject input before starting Windows control", async (t) => {
  const h = harness(t);
  for (const value of [undefined, null, "50", true, {}, NaN, Infinity, -Infinity, -0.001, 100.001, 1n]) {
    assert.deepEqual(await h.bridge.setVolume(value), { available: false, volume: null, muted: false, error: "SYSTEM_VOLUME_INVALID_VALUE" });
  }
  assert.equal(h.calls.length, 0);
  for (const value of [0, 1.5, 100]) assert.equal((await h.bridge.setVolume(value)).volume, value);
});

test("non-Windows reports unsupported without pretending to control OS volume", async () => {
  const bridge = createSystemVolume({ platform: "linux", spawnProcess: () => assert.fail("must not spawn") });
  assert.equal((await bridge.getStatus()).error, "SYSTEM_VOLUME_UNSUPPORTED");
  assert.equal((await bridge.setVolume(50)).error, "SYSTEM_VOLUME_UNSUPPORTED");
  bridge.dispose();
});

test("one hidden persistent process serves concurrent reads and slider changes", async (t) => {
  const h = harness(t);
  const reads = await Promise.all([h.bridge.getStatus(), h.bridge.getStatus(), h.bridge.getStatus()]);
  assert.ok(reads.every((status) => status.volume === 42));
  await h.bridge.setVolume(30);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.windowsHide, true);
  assert.deepEqual(h.calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.ok(h.calls[0].args.includes("-Mta"));
  assert.ok(h.calls[0].args.includes("-EncodedCommand"));
});

test("drag events coalesce into the newest value and resolve all callers with native confirmed state", async (t) => {
  const h = harness(t);
  const results = await Promise.all(Array.from({ length: 70 }, (_, index) => h.bridge.setVolume(index)));
  assert.deepEqual(h.children[0].commands.filter((line) => line.startsWith("set")), ["set 1 69"]);
  assert.ok(results.every((status) => status.volume === 69 && status.available));
});

test("queued drag during helper startup is merged, not replayed", async (t) => {
  const h = harness(t, { ready: false }, { startTimeoutMs: 200 });
  const first = h.bridge.setVolume(10);
  await delay(15);
  const latest = h.bridge.setVolume(80);
  h.children[0].send({ type: "ready", ...state() });
  assert.equal((await first).volume, 80);
  assert.equal((await latest).volume, 80);
  assert.deepEqual(h.children[0].commands, ["set 1 80"]);
});

test("in-flight set finishes before the next coalesced set and returns the actual rounded value", async (t) => {
  const commands = [];
  const h = harness(t, { onCommand: (child, command, id, value) => {
    commands.push({ child, command, id, value });
  } });
  const first = h.bridge.setVolume(10.4);
  await delay(15);
  const second = h.bridge.setVolume(55);
  const latest = h.bridge.setVolume(70.3);
  await delay(15);
  assert.equal(commands.length, 1);
  commands[0].child.send({ type: "response", id: commands[0].id, ...state(10) });
  assert.equal((await first).volume, 10);
  await delay(15);
  assert.equal(commands.length, 2);
  assert.equal(commands[1].value, 70.3);
  commands[1].child.send({ type: "response", id: commands[1].id, ...state(70) });
  assert.equal((await second).volume, 70);
  assert.equal((await latest).volume, 70);
});

test("OS change and default-endpoint status notifications are read-only, ordered, and unsubscribable", async (t) => {
  const h = harness(t);
  const events = [];
  const unsubscribe = h.bridge.subscribe((status) => events.push(status));
  await delay(5);
  const initialRevision = events.at(-1).revision;
  h.children[0].send({ type: "change", ...state(23, true) });
  h.children[0].send({ type: "change", available: false, volume: null, muted: false, error: "SYSTEM_VOLUME_UNAVAILABLE" });
  h.children[0].send({ type: "change", ...state(81, false) });
  assert.deepEqual(events.slice(-3).map((status) => [status.volume, status.muted]), [[23, true], [null, false], [81, false]]);
  assert.ok(events.slice(-3).every((status, index) => status.revision === initialRevision + index + 1));
  assert.ok(h.children[0].commands.every((command) => command.startsWith("get")));
  const count = events.length;
  unsubscribe();
  h.children[0].send({ type: "change", ...state(82) });
  assert.equal(events.length, count);
});

test("fragmented protocol frames work and unknown responses cannot poison confirmed state", async (t) => {
  const h = harness(t);
  const events = [];
  h.bridge.subscribe((status) => events.push(status));
  await delay(5);
  const child = h.children[0];
  child.stdout.write('{"type":"change","available":true,"volume":');
  child.stdout.write('67,"muted":false}\n');
  assert.equal(events.at(-1).volume, 67);
  const count = events.length;
  child.send({ type: "response", id: 999, ...state(99) });
  assert.equal(events.length, count);
});

test("malformed stdout is never accepted as a successful Windows state", async (t) => {
  const h = harness(t, { onCommand: (child) => child.stdout.write("not a status\n") });
  const status = await h.bridge.getStatus();
  assert.equal(status.available, false);
  assert.equal(status.error, "SYSTEM_VOLUME_PROTOCOL");
  assert.equal(h.children[0].killed, true);
  for (const input of [state(NaN), state(101), state(-1), { ...state(), muted: 1 }, { available: false, error: "untrusted path/data" }]) {
    assert.equal(parseStatus(input), null);
  }
});

test("bounded startup timeout permits reconnect, and stale exited helpers cannot overwrite it", async (t) => {
  const h = harness(t, (index) => ({ ready: index > 0 }), { startTimeoutMs: 20 });
  assert.equal((await h.bridge.getStatus()).error, "SYSTEM_VOLUME_TIMEOUT");
  assert.equal(h.children[0].killed, true);
  const status = await h.bridge.getStatus();
  assert.equal(status.available, true);
  h.children[0].send({ type: "change", ...state(99) });
  h.children[0].emit("exit", 1);
  assert.equal((await h.bridge.getStatus()).volume, 42);
  assert.equal(h.calls.length, 2);
});

test("a request timeout releases concurrent callers and terminates the hung helper", async (t) => {
  const h = harness(t, { onCommand: () => {} }, { requestTimeoutMs: 20 });
  const results = await Promise.all([h.bridge.getStatus(), h.bridge.getStatus(), h.bridge.setVolume(34)]);
  assert.ok(results.every((status) => status.error === "SYSTEM_VOLUME_TIMEOUT"));
  assert.equal(h.children[0].killed, true);
});

test("spawn failure and helper exit produce stable errors without rejected IPC promises", async (t) => {
  const failed = harness(t, {}, { spawnProcess: () => { throw Error("private path"); } });
  assert.equal((await failed.bridge.getStatus()).error, "SYSTEM_VOLUME_HELPER_START");
  const h = harness(t, { onCommand: (child) => child.emit("exit", 1) });
  assert.equal((await h.bridge.getStatus()).error, "SYSTEM_VOLUME_HELPER_EXIT");
});

test("dispose cancels unsent sets and active reads, unregisters through quit, and cannot resurrect a helper", async (t) => {
  const queued = harness(t, {}, { coalesceMs: 100 });
  const set = queued.bridge.setVolume(56);
  queued.bridge.dispose();
  assert.equal((await set).error, "SYSTEM_VOLUME_DISPOSED");
  assert.equal(queued.calls.length, 0);
  const h = harness(t, { onCommand: () => {} });
  const read = h.bridge.getStatus();
  await delay(5);
  h.bridge.dispose();
  assert.equal((await read).error, "SYSTEM_VOLUME_DISPOSED");
  assert.equal((await h.bridge.getStatus()).error, "SYSTEM_VOLUME_DISPOSED");
  assert.equal((await h.bridge.setVolume(40)).error, "SYSTEM_VOLUME_DISPOSED");
  assert.equal(h.children[0].commands.at(-1), "quit");
  assert.equal(h.calls.length, 1);
});

test("preload forwards only status, exposes the fixed API, and removes the native event subscription", async () => {
  const ipc = new EventEmitter();
  const invocations = [];
  ipc.invoke = async (...args) => { invocations.push(args); return state(); };
  let exposed;
  vm.runInNewContext(readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } } }),
  });
  const seen = [];
  const unsubscribe = exposed.systemVolume.subscribe((status) => seen.push(status));
  ipc.emit("codio:system-volume-changed", { sender: "must not expose Electron" }, state(73));
  assert.deepEqual(seen, [state(73)]);
  unsubscribe();
  assert.equal(ipc.listenerCount("codio:system-volume-changed"), 0);
  await exposed.systemVolume.getStatus();
  await exposed.systemVolume.setVolume(64);
  assert.deepEqual(invocations, [["codio:system-volume-get"], ["codio:system-volume-set", 64]]);
  assert.equal(typeof exposed.systemVolume.subscribe(null), "function");
  assert.equal(exposed.systemVolume.restoreMute, undefined);
});

test("Node-only verification can restore original mute without changing confirmed volume or exposing a renderer tool", async (t) => {
  const h = harness(t);
  assert.equal((await h.bridge.restoreMute("true")).error, "SYSTEM_VOLUME_INVALID_VALUE");
  assert.equal(h.calls.length, 0);
  assert.equal((await h.bridge.restoreMute(true)).muted, true);
  const zero = await h.bridge.setVolume(0);
  assert.equal(zero.volume, 0);
  assert.equal(zero.muted, true);
  const positive = await h.bridge.setVolume(31);
  assert.equal(positive.volume, 31);
  assert.equal(positive.muted, false);
  const restored = await h.bridge.restoreMute(true);
  assert.equal(restored.volume, 31);
  assert.equal(restored.muted, true);
});

test("system-volume IPC accepts only the live main window and does not let QQ/other windows control Windows volume", async () => {
  const source = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const handlerSource = source.match(/function handleSystemVolume\([^]*?\n}\n/)[0];
  const calls = [];
  const mainContents = {};
  const volumeModule = {
    getStatus: () => { calls.push(["get"]); return state(); },
    setVolume: (value) => { calls.push(["set", value]); return state(value); },
  };
  const bind = new Function("mainWindow", "systemVolume", `${handlerSource}; return handleSystemVolume;`);
  const main = { isDestroyed: () => false, webContents: mainContents };
  const handler = bind(main, volumeModule);
  for (const write of [false, true]) {
    assert.equal(handler({ sender: {} }, 30, write).error, "SYSTEM_VOLUME_UNAUTHORIZED");
    assert.equal(bind(null, volumeModule)({ sender: mainContents }, 30, write).error, "SYSTEM_VOLUME_UNAUTHORIZED");
    assert.equal(bind({ ...main, isDestroyed: () => true }, volumeModule)({ sender: mainContents }, 30, write).error, "SYSTEM_VOLUME_UNAUTHORIZED");
  }
  assert.deepEqual(calls, []);
  assert.equal(handler({ sender: mainContents }).volume, 42);
  assert.equal(handler({ sender: mainContents }, 37, true).volume, 37);
  assert.deepEqual(calls, [["get"], ["set", 37]]);
});

test("helper fits the Windows command-line limit even when packaged in app.asar", () => {
  const script = readFileSync(new URL("../desktop/system-volume.ps1", import.meta.url), "utf8");
  assert.ok(Buffer.from(script, "utf16le").toString("base64").length + 1000 < 32767);
});
