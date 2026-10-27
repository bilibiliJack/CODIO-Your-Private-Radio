const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const unavailable = (error) => ({ available: false, volume: null, muted: false, error });

function parseStatus(message) {
  if (message?.available === true && typeof message.volume === "number" && Number.isFinite(message.volume)
      && message.volume >= 0 && message.volume <= 100 && typeof message.muted === "boolean") {
    return { available: true, volume: message.volume, muted: message.muted };
  }
  if (message?.available === false && typeof message.error === "string" && /^SYSTEM_VOLUME_[A-Z_]+$/.test(message.error)) {
    return unavailable(message.error);
  }
  return null;
}

function createSystemVolume(options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const startTimeoutMs = options.startTimeoutMs ?? 8000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2000;
  const coalesceMs = options.coalesceMs ?? 35;
  const retryMs = options.retryMs ?? 1000;
  const listeners = new Set();
  const pending = new Map();
  let helper = null, starting = null, readyResolve = null, startupTimer = null;
  let disposed = false, nextId = 0, retryAfter = 0, buffer = "", lastStatus = null, revision = 0;
  let setQueue = null, setTimer = null, setRunning = false;

  function publish(status) {
    if (lastStatus && ["available", "volume", "muted", "error"].every((key) => status[key] === lastStatus[key])) return { ...lastStatus };
    lastStatus = { ...status, revision: ++revision };
    for (const listener of listeners) {
      try { listener({ ...lastStatus }); } catch { /* One consumer must not disable OS updates. */ }
    }
    return { ...lastStatus };
  }

  function fail(error, child = helper) {
    if (child !== helper) return unavailable(error);
    const status = publish(unavailable(error));
    helper = null;
    buffer = "";
    clearTimeout(startupTimer);
    startupTimer = null;
    readyResolve?.(status);
    readyResolve = null;
    starting = null;
    retryAfter = Date.now() + retryMs;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.resolve(status);
    }
    pending.clear();
    try { child?.kill(); } catch { /* The helper may already have exited. */ }
    return status;
  }

  function receive(chunk, child) {
    if (child !== helper) return;
    buffer += chunk.toString("utf8");
    if (buffer.length > 65536) { fail("SYSTEM_VOLUME_PROTOCOL", child); return; }
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail("SYSTEM_VOLUME_PROTOCOL", child); return; }
      let status = parseStatus(message);
      if (!status || !["ready", "change", "response"].includes(message.type)) {
        fail("SYSTEM_VOLUME_PROTOCOL", child); return;
      }
      if (message.type === "ready") {
        status = publish(status);
        clearTimeout(startupTimer);
        startupTimer = null;
        readyResolve?.(status);
        readyResolve = null;
        starting = null;
      } else if (message.type === "response") {
        if (!Number.isSafeInteger(message.id) || message.id <= 0) { fail("SYSTEM_VOLUME_PROTOCOL", child); return; }
        const request = pending.get(message.id);
        if (request) {
          status = publish(status);
          clearTimeout(request.timer);
          pending.delete(message.id);
          request.resolve(status);
        }
      } else {
        publish(status);
      }
    }
  }

  function ensureStarted() {
    if (disposed) return Promise.resolve(unavailable("SYSTEM_VOLUME_DISPOSED"));
    if (platform !== "win32") return Promise.resolve(publish(unavailable("SYSTEM_VOLUME_UNSUPPORTED")));
    if (starting) return starting;
    if (helper) return Promise.resolve(lastStatus);
    if (Date.now() < retryAfter) return Promise.resolve(lastStatus);
    starting = new Promise((resolve) => { readyResolve = resolve; });
    const result = starting;
    try {
      // EncodedCommand also works when the .ps1 is inside Electron's read-only app.asar.
      const script = options.helperScript ?? readFileSync(path.join(__dirname, "system-volume.ps1"), "utf8");
      const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      helper = spawnProcess(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Mta", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const child = helper;
      child.stdout.on("data", (chunk) => receive(chunk, child));
      child.stderr.on("data", () => {}); // Drain compiler diagnostics; never expose paths or arbitrary helper text to UI.
      child.stdin.on("error", () => fail("SYSTEM_VOLUME_HELPER_EXIT", child));
      child.once("error", () => fail("SYSTEM_VOLUME_HELPER_START", child));
      child.once("exit", () => fail("SYSTEM_VOLUME_HELPER_EXIT", child));
      startupTimer = setTimeout(() => fail("SYSTEM_VOLUME_TIMEOUT", child), startTimeoutMs);
    } catch { fail("SYSTEM_VOLUME_HELPER_START"); }
    return result;
  }

  function request(command, value) {
    if (!helper) return Promise.resolve(lastStatus ?? unavailable("SYSTEM_VOLUME_HELPER_EXIT"));
    const child = helper;
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, { resolve, timer: setTimeout(() => fail("SYSTEM_VOLUME_TIMEOUT", child), requestTimeoutMs) });
      try { child.stdin.write(`${command} ${id}${value === undefined ? "" : ` ${value}`}\n`); }
      catch { fail("SYSTEM_VOLUME_HELPER_EXIT", child); }
    });
  }

  async function getStatus() {
    const status = await ensureStarted();
    return helper && !disposed ? request("get") : status;
  }

  async function flushSet() {
    setTimer = null;
    if (setRunning || !setQueue) return;
    setRunning = true;
    const started = await ensureStarted();
    const batch = setQueue;
    setQueue = null;
    if (batch) {
      const status = helper && !disposed ? await request("set", batch.value) : started;
      for (const resolve of batch.resolvers) resolve(status);
    }
    setRunning = false;
    if (setQueue && !disposed) setTimer = setTimeout(flushSet, coalesceMs);
  }

  function setVolume(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      return Promise.resolve(unavailable("SYSTEM_VOLUME_INVALID_VALUE"));
    }
    if (disposed) return Promise.resolve(unavailable("SYSTEM_VOLUME_DISPOSED"));
    if (platform !== "win32") return Promise.resolve(publish(unavailable("SYSTEM_VOLUME_UNSUPPORTED")));
    return new Promise((resolve) => {
      if (setQueue) { setQueue.value = value; setQueue.resolvers.push(resolve); }
      else setQueue = { value, resolvers: [resolve] };
      if (!setTimer && !setRunning) setTimer = setTimeout(flushSet, coalesceMs);
    });
  }

  function subscribe(listener) {
    if (typeof listener !== "function" || disposed) return () => {};
    listeners.add(listener);
    if (lastStatus) { try { listener({ ...lastStatus }); } catch {} }
    void getStatus();
    return () => listeners.delete(listener);
  }

  // Node-only verification cleanup. Deliberately not exposed by main/preload to the renderer.
  async function restoreMute(muted) {
    if (typeof muted !== "boolean") return unavailable("SYSTEM_VOLUME_INVALID_VALUE");
    const status = await ensureStarted();
    return helper && !disposed ? request("mute", muted ? 1 : 0) : status;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(setTimer);
    setTimer = null;
    listeners.clear();
    const status = unavailable("SYSTEM_VOLUME_DISPOSED");
    for (const resolve of setQueue?.resolvers ?? []) resolve(status);
    setQueue = null;
    const child = helper;
    helper = null;
    if (child) {
      // EOF/quit unregisters both native callbacks; forced termination is only a bounded fallback.
      try { child.stdin.end("quit\n"); } catch { /* Already closed. */ }
      const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, 500);
      killTimer.unref?.();
      child.once("exit", () => clearTimeout(killTimer));
    }
    clearTimeout(startupTimer);
    readyResolve?.(status);
    readyResolve = null;
    starting = null;
    for (const request of pending.values()) { clearTimeout(request.timer); request.resolve(status); }
    pending.clear();
  }

  return { getStatus, setVolume, subscribe, dispose, restoreMute };
}

module.exports = { createSystemVolume, parseStatus };
