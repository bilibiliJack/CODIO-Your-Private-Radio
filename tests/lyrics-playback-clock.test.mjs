import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Run the actual native media callback: the same callback serves the foreground
// media event and background-safe timer. No playback or lyric algorithm copy.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = [];
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && ["wireMusicAudio", "getAudiblePlaybackTime"].includes(node.name?.text)) declarations.push(node.getText(ast));
  ts.forEachChild(node, visit);
})(ast);
assert.equal(declarations.length, 2);
const js = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const bind = new Function("context", `with(context){${js};return wireMusicAudio;}`);
function harness({ trackId = "actual-track", lyrics = [{ time: 9, text: "first" }, { time: 10, text: "second" }] } = {}) {
  const times = [], playing = [];
  const audio = { currentTime: 8.95, duration: 180, paused: false, ended: false,
    dispatchEvent(event) { this[`on${event.type}`]?.(event); } };
  const context = {
    visualActiveRef: { current: true },
    musicAudioRef: { current: audio }, lyricLinesLiveRef: { current: { trackId, lines: lyrics } },
    audioContextRef: { current: null },
    listeningSessionRef: { current: null }, userPausedRef: { current: false },
    playQueueRef: { current: [] }, activeQueueIndexRef: { current: -1 },
    seamlessRef: { current: false }, seamlessTransitionRef: { current: false },
    seamlessAttemptedRef: { current: null }, playbackFadeRef: { current: 0 },
    trackAnalysisRef: { current: new Map() }, analysisSourceRef: { current: new Map() },
    analyserNodesRef: { current: new Map() }, volumeRef: { current: 70 },
    startingTrackRef: { current: null },
    analysisForAudio: () => null,
    setPlaybackTime: value => times.push(value), setProgress() {}, setIsPlaying: value => playing.push(value),
    advanceFromFinishedAudio() { throw Error("This is not a track-end test"); },
    armPlaybackBoundaryCheck() {}, settleCurrentListening() {}, recoverCurrentTrack() {}, notifySystem() {},
    window: { setTimeout: () => 1, clearTimeout() {} },
  };
  bind(context)(audio, "actual-track");
  return { audio, context, times, playing };
}

test("crossing a lyric cue always commits exact media time even less than .12s after the prior write", () => {
  const h = harness(); h.audio.ontimeupdate();
  h.audio.currentTime = 8.99; h.audio.ontimeupdate();
  assert.equal(h.times.length, 1, "ordinary duplicate time stays throttled");
  h.audio.currentTime = 9.001; h.audio.ontimeupdate();
  assert.equal(h.times.length, 2);
  assert.equal(h.times.at(-1).current, 9.001, "first lyric activates on the real cue, not a stale prior sample");
  h.audio.currentTime = 9.06; h.audio.ontimeupdate();
  assert.equal(h.times.length, 2, "the active line does not cause high-frequency commits");
  h.audio.currentTime = 9.97; h.audio.ontimeupdate();
  h.audio.currentTime = 10.001; h.audio.ontimeupdate();
  assert.equal(h.times.at(-1).current, 10.001);
});

test("background audio keeps advancing without whole-page clock renders and returns to its real time",()=>{
  const h=harness();h.audio.ontimeupdate();const before=h.times.length;
  h.context.visualActiveRef.current=false;
  for(let i=0;i<100;i++){h.audio.currentTime=10+i*.25;h.audio.ontimeupdate();}
  assert.equal(h.times.length,before);assert.equal(h.audio.paused,false);assert.equal(h.audio.currentTime,34.75);
  h.context.visualActiveRef.current=true;h.audio.ontimeupdate();
  assert.equal(h.times.length,before+1);assert.equal(h.times.at(-1).current,34.75);
});

test("cues are never activated early by an artificial .08 second lead", () => {
  const h = harness(); h.audio.ontimeupdate();
  h.audio.currentTime = 8.999; h.audio.ontimeupdate();
  assert.equal(h.times.length, 1);
  h.audio.currentTime = 9; h.audio.ontimeupdate();
  assert.equal(h.times.at(-1).current, 9);
});

test("late lyrics for another identity cannot force a cue update in the current deck", () => {
  const h = harness({ trackId: "old-track" }); h.audio.ontimeupdate();
  h.audio.currentTime = 9.001; h.audio.ontimeupdate();
  assert.equal(h.times.length, 1, "foreign lyrics are ignored rather than attached by title or stale closure");
  h.context.lyricLinesLiveRef.current = { trackId: "actual-track", lines: [{ time: 9, text: "correct" }] };
  h.audio.ontimeupdate();
  assert.equal(h.times.length, 2, "fresh current-identity lyrics are observed without rewiring media events");
});

test("native pause commits the final real playhead rather than leaving the last throttle sample", () => {
  const h = harness(); h.audio.ontimeupdate();
  h.audio.currentTime = 8.98; h.audio.paused = true; h.audio.onpause();
  assert.equal(h.times.at(-1).current, 8.98);
  assert.equal(h.playing.at(-1), false);
  h.audio.onplay();
  assert.equal(h.playing.at(-1), true);
});

test("native seeked commits the real clock for forward, backward and intro seeks", () => {
  const h = harness(); h.audio.ontimeupdate();
  for (const value of [8.97, 10.5, 9.03, 0]) {
    h.audio.currentTime = value; h.audio.onseeked();
    assert.equal(h.times.at(-1).current, value);
  }
});

test("stale outgoing deck events cannot change the committed incoming clock or icon", () => {
  const h = harness(); h.audio.ontimeupdate();
  h.context.musicAudioRef.current = { currentTime: 3, paused: false };
  h.audio.currentTime = 9.001; h.audio.ontimeupdate(); h.audio.onpause(); h.audio.onseeked();
  assert.equal(h.times.length, 1); assert.equal(h.playing.length, 0);
});

test("visible lyrics and progress use connected output latency without changing native playback cues", () => {
  const h = harness();
  h.context.audioContextRef.current = { state: "running", baseLatency: .01, outputLatency: .2 };
  h.context.analyserNodesRef.current.set(h.audio, {});
  h.audio.currentTime = 9.1; h.audio.ontimeupdate();
  assert.ok(Math.abs(h.times.at(-1).current - 8.89) < 1e-9, "do not highlight 9s cue before the connected output reaches it");
  h.audio.currentTime = 9.211; h.audio.ontimeupdate();
  assert.ok(Math.abs(h.times.at(-1).current - 9.001) < 1e-9);
  assert.equal(h.audio.currentTime, 9.211, "display compensation never seeks media or changes scheduling time");
  h.audio.paused = true; h.audio.onpause();
  assert.equal(h.times.at(-1).current, 9.211, "pause publishes the final native position");
});

test("a direct unconnected audio path is not falsely delayed by another deck's AudioContext", () => {
  const h = harness();
  h.context.audioContextRef.current = { state: "running", baseLatency: .03, outputLatency: .8 };
  h.audio.currentTime = 9.001; h.audio.ontimeupdate();
  assert.equal(h.times.at(-1).current, 9.001);
});

test("output clock compensation follows playbackRate and safely ignores unavailable latency", () => {
  const h = harness();
  h.context.audioContextRef.current = { state: "running", baseLatency: .01, outputLatency: .1 };
  h.context.analyserNodesRef.current.set(h.audio, {});
  h.audio.playbackRate = 1.05; h.audio.currentTime = 10; h.audio.ontimeupdate();
  assert.ok(Math.abs(h.times.at(-1).current - 9.8845) < 1e-9);
  h.context.audioContextRef.current.outputLatency = NaN;
  h.context.audioContextRef.current.baseLatency = Infinity;
  h.audio.currentTime = 10.3; h.audio.ontimeupdate();
  assert.equal(h.times.at(-1).current, 10.3);
});
