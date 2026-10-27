import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Run the real shared transport handlers with isolated media and a deterministic
// clock. No QQ credentials, persisted listening data or real Audio are touched.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["togglePlayback", "fadeMusicVolume", "resumeMusicAudioGraph", "holdAudioParam", "getAudiblePlaybackTime", "wireMusicAudio", "startQQTrack", "getPlayerVolumeScalar"];
const declarations = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
})(ast);
for (const name of names) assert.ok(declarations.has(name), `Missing production transport handler: ${name}`);
const javascript = ts.transpileModule([...declarations.values()].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const bind = new Function("context", `with(context) { ${javascript}; return { ${names.join(",")} }; }`);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clock() {
  let now = 0, sequence = 0; const jobs = new Map();
  const schedule = (fn, delay, repeat = 0) => { const id = ++sequence; jobs.set(id, { fn, at: now + Math.max(0, delay), repeat }); return id; };
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
        const [id, job] = next; now = job.at; jobs.delete(id);
        if (job.repeat) jobs.set(id, { ...job, at: now + job.repeat });
        job.fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
function harness({ paused = false, graph = true } = {}) {
  const time = clock(), calls = [], playGates = [];
  const mediaEvents = new EventTarget();
  const parameter = {
    value: paused ? 0 : 1,
    cancelAndHoldAtTime(at) { calls.push(["hold", at]); },
    cancelScheduledValues(at) { calls.push(["cancel", at]); },
    setValueAtTime(value, at) { this.value = value; calls.push(["gain", value, at]); },
    linearRampToValueAtTime(value, at) { calls.push(["ramp", value, at]); },
    setTargetAtTime(value, at, constant) { this.value = value; calls.push(["repair", value, at, constant]); },
  };
  const audio = {
    src: "qa://transport", paused, ended: false, error: null, currentTime: 42, duration: 240, volume: paused ? 0 : .7,
    buffered: { length: 1, end: () => 240 }, dataset: {},
    addEventListener: (...args) => mediaEvents.addEventListener(...args),
    removeEventListener: (...args) => mediaEvents.removeEventListener(...args),
    dispatchEvent(event) {
      calls.push(["event", event.type]);
      const accepted = mediaEvents.dispatchEvent(event);
      this[`on${event.type}`]?.(event);
      return accepted;
    },
    play() {
      calls.push(["play", time.now()]); this.paused = false; this.dispatchEvent(new Event("play"));
      return playGates.shift()?.promise || Promise.resolve();
    },
    pause() { calls.push(["pause", time.now()]); this.paused = true; this.dispatchEvent(new Event("pause")); },
  };
  const audioContext = { state: "running", get currentTime() { return time.now() / 1000; }, resume() { calls.push(["resume-graph", time.now()]); this.state = "running"; return Promise.resolve(); } };
  let playing = !paused;
  const context = {
    visualActiveRef: { current: true },
    window: { ...time, codioDesktop: { qqMusic: {} } }, performance: { now: time.now },
    AudioContext: class { constructor() { return audioContext; } },
    musicAudioRef: { current: audio }, activeQQTrack: { mid: "transport-track", title: "QA", artist: "Transport QA" },
    activeQQTrackLiveRef: { current: { mid: "transport-track" } },
    activeTransitionRef: { current: null }, pendingTransitionAudioRef: { current: null }, seamlessTransitionRef: { current: false },
    playbackFadeRef: { current: 0 }, playbackToggleRef: { current: { revision: 0, pending: false } },
    playbackFadeCancelRef: { current: null },
    userPausedRef: { current: paused }, audioContextRef: { current: graph ? audioContext : null },
    analyserNodesRef: { current: new Map(graph ? [[audio, { gain: { gain: parameter } }]] : []) },
    volumeRef: { current: 70 }, systemVolumeRef: { current: { available: false, volume: null, muted: false } }, startingTrackRef: { current: null }, playbackRequestRef: { current: null },
    listeningSessionRef: { current: null }, seamlessRef: { current: false }, seamlessAttemptedRef: { current: null },
    activeQueueIndexRef: { current: 0 }, playQueueRef: { current: [] }, trackAnalysisRef: { current: new Map() }, analysisSourceRef: { current: new Map() },
    pendingAdvanceRef: { current: false },
    lyricLinesLiveRef: { current: { trackId: "transport-track", lines: [] } },
    PREPARED_TRACK_TTL_MS: 180000, sourceWarmRef: { current: { controller: null } },
    preparedTracksRef: { current: new Map() }, failedTracksRef: { current: new Map() }, audioElementsRef: { current: new Set() },
    resolveTrackCover: async () => "qa-cover",
    setIsPlaying(value) { playing = typeof value === "function" ? value(playing) : value; calls.push(["ui", playing, time.now()]); },
    abortActiveTransition(reason) { calls.push(["abort-transition", reason]); },
    startQQTrack() { calls.push(["restart-source"]); return Promise.resolve("played"); },
    setImportSource() {}, setImportState() {}, setImportOpen() {}, setToast(message) { calls.push(["toast", message]); },
    notifySystem() {}, armPlaybackBoundaryCheck() {}, recoverCurrentTrack() {}, settleCurrentListening() {}, advanceFromFinishedAudio() {},
    setPlaybackTime(value) { calls.push(["time", value]); }, setProgress(value) { calls.push(["progress", value]); }, accumulatePlayingTime: session => session,
    analysisForAudio: () => null,
    withTimeout(promise, duration, label) {
      return new Promise((resolve, reject) => {
        const timer = time.setTimeout(() => reject(Error(`${label}_TIMEOUT`)), duration);
        Promise.resolve(promise).then(value => { time.clearTimeout(timer); resolve(value); }, error => { time.clearTimeout(timer); reject(error); });
      });
    },
  };
  Object.defineProperty(context, "isPlaying", { get: () => playing });
  const handlers = bind(context);
  for (const [name, handler] of Object.entries(handlers)) if (name !== "startQQTrack") context[name] = handler;
  return { context, handlers, audio, audioContext, parameter, calls, playGates, time, playing: () => playing };
}

test("pause records intent and icon immediately, with a bounded short audible fade", async () => {
  const h = harness(); const request = h.handlers.togglePlayback();
  assert.equal(h.context.userPausedRef.current, true);
  assert.equal(h.playing(), false, "do not wait for fade or media events to update the icon");
  await h.time.advance(140); await request;
  assert.equal(h.audio.paused, true);
  assert.ok(h.calls.find(call => call[0] === "pause")[1] <= 140);
  assert.equal(h.calls.some(call => call[0] === "restart-source"), false);
});

test("resume during an unfinished pause cancels the old pause and keeps the latest intent", async () => {
  const h = harness(); const pause = h.handlers.togglePlayback(); await h.time.advance(25);
  const resume = h.handlers.togglePlayback();
  assert.equal(h.context.userPausedRef.current, false);
  assert.equal(h.playing(), true);
  await h.time.advance(1200); await Promise.all([pause, resume]);
  assert.equal(h.audio.paused, false, "the first pause must never run after resume");
  assert.equal(h.playing(), true);
  assert.equal(h.calls.filter(call => call[0] === "restart-source").length, 0);
});

test("an actually paused media element can resume even when no explicit pause intent was recorded", async () => {
  const h = harness({ paused: true }); h.context.userPausedRef.current = false;
  const request = h.handlers.togglePlayback(); await flush(); await h.time.advance(1200); await request;
  assert.equal(h.playing(), true); assert.equal(h.audio.paused, false);
  assert.equal(h.calls.filter(call => call[0] === "play").length, 1);
});

test("rapid pause resume pause settles to the last user intent without stale flips", async () => {
  const h = harness(); const first = h.handlers.togglePlayback(); await h.time.advance(20);
  const second = h.handlers.togglePlayback(); await h.time.advance(20);
  const third = h.handlers.togglePlayback(); await h.time.advance(1200); await Promise.all([first, second, third]);
  assert.equal(h.context.userPausedRef.current, true);
  assert.equal(h.playing(), false); assert.equal(h.audio.paused, true);
});

test("pause supersedes a pending play promise and its late completion", async () => {
  const h = harness({ paused: true }); const gate = deferred(); h.playGates.push(gate);
  const resume = h.handlers.togglePlayback(); assert.equal(h.playing(), true); await flush();
  const pause = h.handlers.togglePlayback(); assert.equal(h.playing(), false);
  await h.time.advance(140); gate.resolve(); await flush(); await h.time.advance(1000); await Promise.all([resume, pause]);
  assert.equal(h.audio.paused, true); assert.equal(h.playing(), false);
  assert.equal(h.context.userPausedRef.current, true);
});

test("latest media rejection rolls back without reloading the song or repeating playback", async () => {
  const h = harness({ paused: true }); const gate = deferred(); h.playGates.push(gate);
  const request = h.handlers.togglePlayback(); await flush(); gate.reject(Error("source temporarily stalled"));
  await flush(); await h.time.advance(1200); await request;
  assert.equal(h.playing(), false); assert.equal(h.audio.paused, true);
  assert.equal(h.calls.filter(call => call[0] === "restart-source").length, 0);
  assert.equal(h.calls.filter(call => call[0] === "play").length, 1);
});

test("an old failed play cannot roll back a newer successful resume", async () => {
  const h = harness({ paused: true }), oldGate = deferred(), newGate = deferred(); h.playGates.push(oldGate, newGate);
  const oldResume = h.handlers.togglePlayback(); await flush();
  const pause = h.handlers.togglePlayback(); await h.time.advance(140);
  const newResume = h.handlers.togglePlayback(); await flush(); newGate.resolve(); await flush();
  oldGate.reject(Error("old request failed late")); await flush(); await h.time.advance(1200); await Promise.all([oldResume, pause, newResume]);
  assert.equal(h.context.userPausedRef.current, false); assert.equal(h.playing(), true); assert.equal(h.audio.paused, false);
});

test("a suspended graph has a bounded timeout rather than hanging transport indefinitely", async () => {
  const h = harness({ paused: true }); h.audioContext.state = "suspended";
  h.audioContext.resume = () => new Promise(() => {});
  const request = h.handlers.togglePlayback(); assert.equal(h.playing(), true); await flush();
  await h.time.advance(8000); await request;
  assert.equal(h.playing(), false); assert.equal(h.context.userPausedRef.current, true);
  assert.equal(h.calls.some(call => call[0] === "restart-source"), false);
});

test("superseding a gain fade disposes its timer instead of accumulating stale jobs", async () => {
  const h = harness(); const first = h.handlers.fadeMusicVolume(h.audio, 0, 120);
  const second = h.handlers.fadeMusicVolume(h.audio, 1, 180);
  await flush(); assert.ok(h.time.jobs.size <= 1, "only the latest fade completion may stay scheduled");
  await h.time.advance(220); assert.equal(await first, false); assert.equal(await second, true);
  assert.equal(h.time.jobs.size, 0);
  assert.ok(h.calls.some(call => call[0] === "hold"), "hold the actual gain instead of snapping back to an old endpoint");
});

test("the native-volume fallback also cancels superseded intervals and resumes normally", async () => {
  const h = harness({ graph: false }); const pause = h.handlers.togglePlayback(); await h.time.advance(25);
  const resume = h.handlers.togglePlayback(); await h.time.advance(1200); await Promise.all([pause, resume]);
  assert.equal(h.audio.paused, false); assert.equal(h.playing(), true);
  assert.ok(Math.abs(h.audio.volume - .7) < .001); assert.equal(h.time.jobs.size, 0);
});

test("late onplaying recovery cannot revive a gain after the user pauses", async () => {
  const h = harness(); h.handlers.wireMusicAudio(h.audio, "transport-track");
  h.audio.onplaying(); const pause = h.handlers.togglePlayback(); await h.time.advance(1200); await pause;
  assert.equal(h.playing(), false); assert.equal(h.audio.paused, true);
  assert.equal(h.calls.filter(call => call[0] === "repair" && call[1] === 1).length, 0);
});

test("a stale play event cannot flip the icon against the latest pause intention", () => {
  const h = harness(); h.handlers.wireMusicAudio(h.audio, "transport-track");
  h.context.userPausedRef.current = true; h.context.setIsPlaying(false); h.audio.paused = false;
  h.audio.onplay();
  assert.equal(h.playing(), false); assert.equal(h.audio.paused, true);
});

test("native pause and seeked dispatch real timeupdate so final playhead is not throttled", () => {
  const h = harness(); h.handlers.wireMusicAudio(h.audio, "transport-track");
  h.audio.dispatchEvent(new Event("timeupdate"));
  h.audio.currentTime = 42.03; h.audio.dispatchEvent(new Event("timeupdate"));
  assert.equal(h.calls.filter(call => call[0] === "time").length, 1, "Ignore a duplicate normal sub-threshold timeupdate");
  h.audio.pause();
  assert.equal(h.calls.filter(call => call[0] === "time").length, 2);
  assert.equal(h.calls.filter(call => call[0] === "time").at(-1)[1].current, 42.03);
  h.audio.currentTime = 42.04; h.audio.dispatchEvent(new Event("seeked"));
  assert.equal(h.calls.filter(call => call[0] === "time").length, 3);
  assert.equal(h.calls.filter(call => call[0] === "time").at(-1)[1].current, 42.04);
  assert.equal(h.calls.filter(call => call[0] === "progress").at(-1)[1], 42.04 / 240 * 100);
});

test("pausing while a source request is pending blocks both its late commit and stale retries", async () => {
  for (const failsLate of [false, true]) {
    const h = harness(), source = deferred(), selected = { mid: "next-source", title: "QA Next", artist: "Transport QA" };
    h.context.playbackRequestRef.current = { id: selected.mid, at: 0 };
    h.context.window.codioDesktop.qqMusic.play = () => source.promise;
    const starting = h.handlers.startQQTrack(selected, 1); await flush();
    assert.equal(h.context.startingTrackRef.current, selected.mid);
    const pause = h.handlers.togglePlayback(); await h.time.advance(140); await pause;
    if (failsLate) source.reject(Error("old source request failed after pause"));
    else source.resolve({ playable: true, url: "qa://late-source" });
    await flush();
    assert.equal(await starting, "superseded");
    assert.equal(h.playing(), false); assert.equal(h.audio.paused, true);
    assert.equal(h.context.userPausedRef.current, true);
    assert.equal(h.context.audioElementsRef.current.size, 0, "no late source media may be created");
    assert.equal(h.calls.filter(call => call[0] === "restart-source").length, 0, "a canceled source cannot retry itself");
    assert.equal(h.context.activeQQTrackLiveRef.current.mid, "transport-track");
  }
});
