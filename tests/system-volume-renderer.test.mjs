import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise renderer code itself; no QQ connection, native writes, or user files.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
const effects = [];
const volumeSliders = [];
const volumeControlRegions = [];
let adjustVolumeBranch;
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    declarations.set(node.name.text, `const ${node.name.text} = ${node.initializer.getText(ast)};`);
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
    && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === "useCallback") {
    declarations.set(node.name.text, `const ${node.name.text} = ${node.initializer.arguments[0].getText(ast)};`);
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect") {
    effects.push(node.arguments[0].getText(ast));
  }
  if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === "input") {
    const attributes = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map(attribute => [attribute.name.getText(ast), attribute.initializer]));
    const value = attributes.get("value");
    if (value && ts.isJsxExpression(value) && value.expression?.getText(ast) === "volume") {
      volumeSliders.push(attributes);
    }
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "div"
    && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
      && attribute.name.getText(ast) === "className" && ts.isStringLiteral(attribute.initializer)
      && attribute.initializer.text === "player-tools")) volumeControlRegions.push(node);
  if (ts.isIfStatement(node) && node.expression.getText(ast) === 'call.name === "adjust_volume"') {
    adjustVolumeBranch = node.getText(ast);
  }
  ts.forEachChild(node, visit);
})(ast);

function bind(names, context) {
  const selected = names.map(name => {
    assert.ok(declarations.has(name), `Missing production volume handler: ${name}`);
    return declarations.get(name);
  });
  const javascript = ts.transpileModule(selected.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("context", `with(context) { ${javascript}; return { ${names.join(",")} }; }`)(context);
}
function expression(code, context) {
  const javascript = ts.transpileModule(`const handler = ${code};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("context", `with(context) { ${javascript}; return handler; }`)(context);
}
function systemEffect(context) {
  const effect = effects.find(code => code.includes("systemVolume") && code.includes("subscribe"));
  assert.ok(effect, "Missing production system-volume subscription effect");
  return expression(effect, context)();
}
function volumeEffect(context) {
  const effect = effects.find(code => code.includes("master.gain.gain.setTargetAtTime"));
  assert.ok(effect, "Missing production audio master volume effect");
  return expression(effect, context)();
}
function sliderHandler(index, context) {
  assert.equal(volumeSliders.length, 2, "Both actual player sliders must be exercised");
  const initializer = volumeSliders[index].get("onChange");
  assert.ok(initializer && ts.isJsxExpression(initializer) && initializer.expression);
  return expression(initializer.expression.getText(ast), context);
}
function sliderAttribute(index, name, context) {
  const initializer = volumeSliders[index].get(name);
  assert.ok(initializer, `Missing actual slider ${name}`);
  return ts.isJsxExpression(initializer) ? expression(`() => (${initializer.expression.getText(ast)})`, context)() : initializer.text;
}
function adjustVolumeTool(context) {
  assert.ok(adjustVolumeBranch, "Missing production adjust_volume execution branch");
  return expression(`async (call) => { const args = call.arguments; ${adjustVolumeBranch}; }`, context);
}
function renderVolumeControls(context) {
  assert.equal(volumeControlRegions.length, 2, "Both actual volume control regions must be rendered");
  Object.assign(context, { React, lyricMode: "cinematic", setLyricMode() {}, seamless: true, setSeamless() {} });
  return volumeControlRegions.map(node => {
    const javascript = ts.transpileModule(`const controls = ${node.getText(ast)};`, {
      fileName: "VolumeControls.tsx", compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function("context", `with(context) { ${javascript}; return controls; }`)(context);
  });
}
function visibleText(element) {
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(visibleText).join("");
  return React.isValidElement(element) ? visibleText(element.props.children) : "";
}

const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let now = 0, sequence = 0;
  const jobs = new Map();
  const schedule = (fn, delay, repeat = 0) => {
    const id = ++sequence;
    jobs.set(id, { fn, at: now + Math.max(0, delay), repeat });
    return id;
  };
  return {
    now: () => now, jobs,
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => jobs.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => jobs.delete(id),
    async advance(amount) {
      await flush();
      const end = now + amount;
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, job] = next;
        now = job.at;
        jobs.delete(id);
        if (job.repeat) jobs.set(id, { ...job, at: now + job.repeat });
        job.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
function parameter(value = 1) {
  return {
    value, scheduled: [],
    cancelScheduledValues() {}, cancelAndHoldAtTime() {},
    setValueAtTime(next) { this.value = next; },
    setTargetAtTime(next) { this.value = next; },
    linearRampToValueAtTime(next, at) { this.scheduled.push([next, at]); },
  };
}
function audioHarness({ graph = true, volume = 68, status = null } = {}) {
  const time = clock();
  const audio = { volume: 0 };
  const deckParameter = parameter(0);
  const graphContext = {
    currentTime: 10,
    destination: {},
    createGain: () => ({ gain: parameter(), connect() {} }),
    createDynamicsCompressor: () => ({
      threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect() {},
    }),
  };
  const context = {
    window: time, performance: { now: time.now },
    volumeRef: { current: volume }, musicMasterRef: { current: null },
    systemVolumeRef: { current: status || { available: false, volume: null, muted: false } },
    audioContextRef: { current: graph ? graphContext : null },
    analyserNodesRef: { current: new Map(graph ? [[audio, { gain: { gain: deckParameter } }]] : []) },
    playbackFadeCancelRef: { current: null }, playbackFadeRef: { current: 0 },
  };
  const handlers = bind(["getMusicMaster", "getPlayerVolumeScalar", "fadeMusicVolume", "holdAudioParam"], context);
  Object.assign(context, handlers);
  return { context, handlers, audio, graphContext, deckParameter, time };
}
function volumeHarness({ bridge = true, status = null, getStatus, setVolume } = {}) {
  const calls = [], notices = [], updates = [];
  let displayedVolume = 68, displayedStatus = status, subscriber;
  const native = {
    getStatus() { calls.push(["getStatus"]); return getStatus ? getStatus() : Promise.resolve({ available: true, volume: 42, muted: false }); },
    setVolume(value) { calls.push(["setVolume", value]); return setVolume ? setVolume(value) : Promise.resolve({ available: true, volume: value, muted: false }); },
    subscribe(listener) { calls.push(["subscribe"]); subscriber = listener; return () => { calls.push(["unsubscribe"]); subscriber = null; }; },
  };
  const context = {
    window: { ...(bridge ? { codioDesktop: { systemVolume: native } } : {}) },
    volumeRef: { current: 68 }, systemVolumeRef: { current: status || { available: false, volume: null, muted: false } },
    systemVolumeRequestRef: { current: 0 }, systemVolumePendingRef: { current: 0 },
    audioContextRef: { current: null }, musicMasterRef: { current: null }, musicAudioRef: { current: null },
    setVolume(value) { displayedVolume = typeof value === "function" ? value(displayedVolume) : value; updates.push(displayedVolume); },
    setSystemVolume(value) { displayedStatus = typeof value === "function" ? value(displayedStatus) : value; },
    notifySystem(...args) { notices.push(args); }, setToast(...args) { notices.push(args); },
    withTimeout: promise => promise,
  };
  Object.defineProperties(context, {
    volume: { get: () => displayedVolume },
    systemVolume: { get: () => displayedStatus },
  });
  const handlers = bind(["applySystemVolumeStatus", "changeVolume", "getPlayerVolumeScalar"], context);
  Object.assign(context, handlers);
  return {
    context, handlers, calls, notices, updates, native,
    volume: () => displayedVolume, status: () => displayedStatus,
    emit(value) { assert.ok(subscriber, "Subscription should already be installed"); subscriber(value); },
    writes: () => calls.filter(([name]) => name === "setVolume"),
  };
}
function playbackHarness({ native = false, graph = false } = {}) {
  const status = { available: native, volume: native ? 25 : null, muted: false };
  const h = audioHarness({ graph, volume: 25, status });
  const fades = [], track = { mid: "volume-test", title: "Volume QA", artist: "QA", durationSeconds: 240 };
  Object.assign(h.audio, {
    src: "qa://audio", dataset: {}, paused: true, ended: false, error: null,
    currentTime: 0, duration: 240, readyState: 4, buffered: { length: 0 },
    async play() { this.paused = false; }, pause() { this.paused = true; },
  });
  Object.assign(h.context, {
    Audio: class { constructor() { return h.audio; } },
    musicAudioRef: { current: h.audio }, activeQQTrack: track,
    window: { ...h.context.window, codioDesktop: { qqMusic: { async play() { return { playable: true, url: "qa://audio" }; } } } },
    activeQQTrackLiveRef: { current: track }, currentCoverDataLiveRef: { current: "" },
    activeTransitionRef: { current: null }, pendingTransitionAudioRef: { current: null }, seamlessTransitionRef: { current: false },
    userPausedRef: { current: false }, playbackToggleRef: { current: { revision: 0, pending: false } },
    playbackRequestRef: { current: { id: track.mid, at: 0 } }, sourceWarmRef: { current: { controller: null } },
    preparedTracksRef: { current: new Map() }, bufferedSourcesRef: { current: new Map() },
    failedTracksRef: { current: new Map() }, audioElementsRef: { current: new Set() },
    seamlessAttemptedRef: { current: null }, pendingAdvanceRef: { current: false }, startingTrackRef: { current: null },
    listeningSessionRef: { current: null }, PREPARED_TRACK_TTL_MS: 180000,
    withTimeout: promise => promise, async resumeMusicAudioGraph() { return graph; },
    async resolveTrackCover() { return ""; }, async analyseTrackWhenBuffered() { return null; },
    connectMusicAnalyser() {}, wireMusicAudio() {}, analysisForAudio() { return null; },
    abortActiveTransition() {}, releaseMusicAudio() {}, discardPreparedEntry() {},
    setActiveQQTrack() {}, setCurrentCoverData() {}, setPlaybackQuality() {}, setProgress() {}, setPlaybackTime() {},
    setIsPlaying() {}, setToast() {}, notifySystem() {}, armPlaybackBoundaryCheck() {},
    beginListeningForTrack() {}, recommendationSourceForTrack() { return "manual_select"; }, rememberPlayedTrack() {},
    prepareUpcomingTrack() {}, settleCurrentListening() {}, setBoundedCache(cache, key, value) { cache.set(key, value); },
    async fadeMusicVolume(audio, target, duration) { fades.push([target, duration]); audio.volume = target; return true; },
  });
  const handlers = bind(["startQQTrack", "togglePlayback", "getPlayerVolumeScalar"], h.context);
  return { ...h, handlers, track, fades };
}

test("browser-only playback preserves its app volume and existing master headroom", () => {
  const h = audioHarness({ volume: 68 });
  const master = h.handlers.getMusicMaster(h.graphContext);
  assert.ok(Math.abs(master.gain.gain.value - .68 * .82) < .000001);
  assert.equal(h.handlers.getMusicMaster(h.graphContext), master, "Reuse the existing audio master");
});

test("deck fades remain envelopes, not a second multiplication by user volume", async () => {
  const h = audioHarness({ volume: 25 });
  const fading = h.handlers.fadeMusicVolume(h.audio, 1, 180);
  assert.deepEqual(h.deckParameter.scheduled, [[1, 10.18]]);
  await h.time.advance(220);
  assert.equal(await fading, true);
  assert.equal(h.time.jobs.size, 0);
});

test("browser without WebAudio still fades the media element to app volume", async () => {
  const h = audioHarness({ graph: false, volume: 25 });
  const fading = h.handlers.fadeMusicVolume(h.audio, .25, 180);
  await h.time.advance(220);
  assert.equal(await fading, true);
  assert.equal(h.audio.volume, .25);
  assert.equal(h.time.jobs.size, 0);
});

test("native master is not multiplied by the Windows volume a second time", () => {
  for (const volume of [0, 25, 68, 100]) {
    const status = { available: true, volume, muted: volume === 0 };
    const h = audioHarness({ volume, status });
    const master = h.handlers.getMusicMaster(h.graphContext);
    assert.equal(master.gain.gain.value, .82, "Keep only the existing fixed DSP headroom");
    assert.equal(h.handlers.getPlayerVolumeScalar(), 1);
    h.context.volume = volume;
    h.context.systemVolume = status;
    h.context.musicAudioRef = { current: h.audio };
    volumeEffect(h.context);
    assert.equal(master.gain.gain.value, .82);
  }
});

test("native playback without WebAudio uses a unity media gain, including OS mute", () => {
  const h = audioHarness({ graph: false, volume: 37, status: { available: true, volume: 37, muted: true } });
  h.context.volume = 37;
  h.context.systemVolume = h.context.systemVolumeRef.current;
  h.context.musicAudioRef = { current: h.audio };
  volumeEffect(h.context);
  assert.equal(h.audio.volume, 1, "Windows handles its own scalar and mute");
});

test("actual start and resume paths select unity gain for native and local scalar for browsers", async () => {
  for (const native of [false, true]) {
    const h = playbackHarness({ native });
    await h.handlers.togglePlayback();
    assert.deepEqual(h.fades, [[native ? 1 : .25, 180]]);
    h.fades.length = 0;
    h.context.musicAudioRef.current = null;
    assert.equal(await h.handlers.startQQTrack(h.track, 0), "played");
    assert.deepEqual(h.fades, [[native ? 1 : .25, 620]]);
  }
});

test("initial read and OS subscriptions update both sliders without native write-back", async () => {
  const h = volumeHarness();
  const cleanup = systemEffect(h.context);
  await flush();
  assert.equal(h.volume(), 42);
  assert.equal(h.context.volumeRef.current, 42);
  assert.deepEqual(h.writes(), []);
  h.emit({ available: true, volume: 73, muted: true });
  assert.equal(h.volume(), 73, "Mute must not erase the remembered Windows scalar");
  assert.equal(h.status().muted, true);
  assert.equal(h.context.systemVolumeRef.current.muted, true);
  assert.deepEqual(h.writes(), []);
  cleanup();
  assert.equal(h.calls.filter(([name]) => name === "unsubscribe").length, 1);
});

test("both actual slider attributes expose Windows mute without losing its scalar", async () => {
  const h = volumeHarness();
  h.handlers.applySystemVolumeStatus({ available: true, volume: 37, muted: true });
  for (let index = 0; index < 2; index += 1) {
    assert.match(sliderAttribute(index, "aria-label", h.context), /系统音量/);
    assert.equal(sliderAttribute(index, "aria-valuetext", h.context), "37%，已静音");
  }
  h.handlers.applySystemVolumeStatus({ available: true, volume: 37, muted: false });
  for (let index = 0; index < 2; index += 1) assert.equal(sliderAttribute(index, "aria-valuetext", h.context), "37%");
  assert.deepEqual(h.writes(), []);
});

test("actual player control JSX has no visible percentage output while retaining both accessible volume values", async () => {
  const h = volumeHarness();
  const verify = () => {
    const accessibleValue = `${Math.round(h.volume())}%${h.status()?.muted ? "，已静音" : ""}`;
    for (const controls of renderVolumeControls(h.context)) {
      assert.doesNotMatch(visibleText(controls), /\d+(?:\.\d+)?%|MUTED/);
      const html = renderToStaticMarkup(controls);
      assert.doesNotMatch(html, /<output\b/);
      assert.ok(html.includes(`aria-valuetext="${accessibleValue}"`), "The percentage remains available to screen readers only");
    }
  };
  h.handlers.applySystemVolumeStatus({ available: true, volume: 42, muted: false });
  verify();
  sliderHandler(0, h.context)({ target: { value: "27" } });
  await flush();
  verify();
  h.handlers.applySystemVolumeStatus({ available: true, volume: 73, muted: true });
  verify();
  assert.equal(h.volume(), 73);
});

test("status revisions reject older OS notifications and malformed available readings", () => {
  const h = volumeHarness();
  assert.equal(h.handlers.applySystemVolumeStatus({ available: true, volume: 75, muted: false, revision: 12 }), true);
  assert.equal(h.handlers.applySystemVolumeStatus({ available: true, volume: 25, muted: true, revision: 11 }), false);
  for (const volume of [null, NaN, Infinity, -1, 101]) {
    assert.equal(h.handlers.applySystemVolumeStatus({ available: true, volume, muted: false, revision: 13 }), false);
  }
  assert.equal(h.volume(), 75);
  assert.equal(h.status().muted, false);
  assert.equal(h.context.systemVolumeRef.current.revision, 12);
});

test("unavailable native service preserves an already confirmed unity-gain mode", async () => {
  const h = volumeHarness({ setVolume: async () => ({ available: false, volume: null, muted: false, error: "NO_AUDIO_ENDPOINT" }) });
  h.handlers.applySystemVolumeStatus({ available: true, volume: 42, muted: false });
  const result = await h.handlers.changeVolume(80);
  assert.equal(result.ok, false);
  assert.equal(result.scope, "system");
  assert.equal(h.volume(), 42);
  assert.equal(h.handlers.getPlayerVolumeScalar(), 1);
  assert.equal(h.status().available, true);
});

test("late initialization and native writes are ignored after subscription cleanup", async () => {
  const initial = deferred(), write = deferred();
  const h = volumeHarness({ getStatus: () => initial.promise, setVolume: () => write.promise });
  const cleanup = systemEffect(h.context);
  const writing = h.handlers.changeVolume(30);
  cleanup();
  const updatesBefore = [...h.updates];
  initial.resolve({ available: true, volume: 88, muted: false });
  write.resolve({ available: true, volume: 30, muted: false });
  await flush();
  assert.equal((await writing).ok, false);
  assert.deepEqual(h.updates, updatesBefore);
});

test("late initialization cannot overwrite a slider drag made during startup", async () => {
  const initial = deferred();
  const h = volumeHarness({ getStatus: () => initial.promise });
  const cleanup = systemEffect(h.context);
  const dragging = h.handlers.changeVolume(30);
  await flush();
  assert.equal((await dragging).ok, true);
  initial.resolve({ available: true, volume: 88, muted: false });
  await flush();
  assert.equal(h.volume(), 30);
  assert.equal(h.context.volumeRef.current, 30);
  assert.deepEqual(h.writes(), [["setVolume", 30]], "Early drag must change Windows, not only the fallback player gain");
  cleanup();
});

test("out-of-order native write responses cannot overwrite the latest drag", async () => {
  const first = deferred(), second = deferred();
  const h = volumeHarness({ setVolume: value => value === 20 ? first.promise : second.promise });
  h.handlers.applySystemVolumeStatus({ available: true, volume: 42, muted: false });
  const firstWrite = h.handlers.changeVolume(20);
  const secondWrite = h.handlers.changeVolume(80);
  second.resolve({ available: true, volume: 80, muted: false });
  assert.equal((await secondWrite).ok, true);
  first.resolve({ available: true, volume: 20, muted: false });
  const stale = await firstWrite;
  assert.equal(stale.ok, false, "A superseded operation must not report that its value is now active");
  assert.equal(h.volume(), 80);
  assert.equal(h.context.volumeRef.current, 80);
  assert.equal(h.context.systemVolumeRef.current.volume, 80);
});

test("an intermediate OS notification cannot roll back the newer pending drag", async () => {
  const initial = { available: true, volume: 42, muted: false }, gate = deferred();
  const h = volumeHarness({ getStatus: async () => initial, setVolume: () => gate.promise });
  const cleanup = systemEffect(h.context);
  await flush();
  const writing = h.handlers.changeVolume(80);
  h.emit({ available: true, volume: 20, muted: false });
  assert.equal(h.volume(), 80, "Retain the latest drag while saving the confirmed native notification");
  gate.resolve({ available: true, volume: 80, muted: false });
  assert.equal((await writing).ok, true);
  assert.equal(h.volume(), 80);
  cleanup();
});

test("an older successful ack preserves a newer confirmed OS callback and reports its actual state", async () => {
  const gate = deferred();
  const h = volumeHarness({
    getStatus: async () => ({ available: true, volume: 42, muted: false, revision: 1 }),
    setVolume: () => gate.promise,
  });
  const cleanup = systemEffect(h.context);
  await flush();
  const writing = h.handlers.changeVolume(80);
  h.emit({ available: true, volume: 70, muted: true, revision: 3 });
  gate.resolve({ available: true, volume: 80, muted: false, revision: 2 });
  const result = await writing;
  assert.equal(result.ok, true, "The write succeeded; a newer native callback is the current state");
  assert.equal(result.after, 70);
  assert.equal(result.muted, true);
  assert.equal(h.volume(), 70);
  assert.equal(h.context.volumeRef.current, 70);
  assert.equal(h.status().volume, 70);
  assert.equal(h.status().muted, true);
  assert.equal(h.context.systemVolumeRef.current.revision, 3);
  cleanup();
});

test("both sliders and AI use the same native updater and return the confirmed scalar", async () => {
  const h = volumeHarness({ setVolume: async value => ({ available: true, volume: Math.round(value), muted: false }) });
  h.handlers.applySystemVolumeStatus({ available: true, volume: 42, muted: false });
  sliderHandler(0, h.context)({ target: { value: "18" } });
  await flush();
  sliderHandler(1, h.context)({ target: { value: "55" } });
  await flush();
  const result = await adjustVolumeTool(h.context)({ name: "adjust_volume", arguments: { operation: "increase", value: 10 } });
  assert.deepEqual(h.writes(), [["setVolume", 18], ["setVolume", 55], ["setVolume", 65]]);
  assert.equal(result.ok, true);
  assert.equal(result.before, 55);
  assert.equal(result.after, 65);
  assert.equal(result.scope, "system");
  assert.equal(h.volume(), 65);
});

test("a native result uses the read-back scalar rather than the requested approximation", async () => {
  const h = volumeHarness({ setVolume: async () => ({ available: true, volume: 67, muted: false }) });
  h.handlers.applySystemVolumeStatus({ available: true, volume: 42, muted: false });
  const result = await h.handlers.changeVolume(66.6);
  assert.equal(result.ok, true);
  assert.equal(result.after, 67);
  assert.equal(h.volume(), 67);
  assert.equal(h.context.volumeRef.current, 67);
});

test("the shared volume boundary rejects invalid values without writes or optimistic state changes", async () => {
  const h = volumeHarness();
  for (const value of [NaN, Infinity, -1, 101, "50", undefined, null]) {
    const result = await h.handlers.changeVolume(value);
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_VOLUME");
  }
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.updates, []);
  assert.equal(h.volume(), 68);
});

test("native errors do not turn into a successful AI result or keep an unconfirmed UI value", async () => {
  for (const rejects of [false, true]) {
    const h = volumeHarness({ setVolume: async () => {
      if (rejects) throw Error("WINDOWS_VOLUME_FAILED");
      return { available: true, volume: 42, muted: false, error: "WINDOWS_VOLUME_FAILED" };
    } });
    h.handlers.applySystemVolumeStatus({ available: true, volume: 42, muted: false });
    const result = await adjustVolumeTool(h.context)({ name: "adjust_volume", arguments: { operation: "set", value: 90 } });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(h.volume(), 42);
    assert.equal(h.context.volumeRef.current, 42);
    assert.equal(result.after, 42);
  }
});

test("failed write rolls back to the latest OS mute notification, not the state before the drag", async () => {
  const gate = deferred();
  const h = volumeHarness({ setVolume: () => gate.promise });
  const cleanup = systemEffect(h.context);
  await flush();
  const writing = h.handlers.changeVolume(80);
  h.emit({ available: true, volume: 42, muted: true, revision: 7 });
  gate.reject(Error("NO_AUDIO_ENDPOINT"));
  const result = await writing;
  assert.equal(result.ok, false);
  assert.equal(h.volume(), 42);
  assert.equal(h.status().muted, true, "The displayed mute state must match the confirmed native state too");
  assert.equal(sliderAttribute(0, "aria-valuetext", h.context), "42%，已静音");
  cleanup();
});

test("offline volume commands also avoid a success claim when the native write fails", async () => {
  const h = volumeHarness({ setVolume: async () => ({ available: false, volume: null, muted: false, error: "NO_AUDIO_ENDPOINT" }) });
  h.handlers.applySystemVolumeStatus({ available: true, volume: 42, muted: false });
  h.context.isOfflineCodioShortcut = () => true;
  h.context.executeCodioTool = adjustVolumeTool(h.context);
  const { replyTo } = bind(["replyTo"], h.context);
  const reply = await replyTo("音量调到90");
  assert.doesNotMatch(reply, /音量已设为/);
  assert.match(reply, /没有完成|失败|没有确认/);
  assert.equal(h.volume(), 42);
});

test("browser-only sliders and AI retain the local player fallback without native IPC", async () => {
  const h = volumeHarness({ bridge: false });
  sliderHandler(0, h.context)({ target: { value: "27" } });
  await flush();
  sliderHandler(1, h.context)({ target: { value: "46" } });
  await flush();
  const result = await adjustVolumeTool(h.context)({ name: "adjust_volume", arguments: { operation: "decrease", value: 10 } });
  assert.equal(result.ok, true);
  assert.equal(result.scope, "player");
  assert.equal(h.volume(), 36);
  assert.equal(h.handlers.getPlayerVolumeScalar(), .36);
  assert.deepEqual(h.writes(), []);
});
