import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const agent = await import(`data:text/javascript;base64,${Buffer.from(compile(await readFile(new URL("../app/codio-agent.ts", import.meta.url), "utf8"))).toString("base64")}`);
const call = (target_type, target, value = "more") => ({ id: target, name: "record_music_preference", arguments: {
  target_type, ...(target_type === "artist" ? { artist_name: target } : { track_id: target }), value,
} });
const tracks = [{ id: "fixture-wind", title: "风衣", artist: "孙燕姿" }, { id: "fixture-vortex", title: "漩涡", artist: "孙燕姿" }];
const text = "I recently fell in love with 孙燕姿's music, especially the 风衣 and 漩涡, it felt like stepping into gorgeous stories";
const policy = userText => ({ userText, qqConnected: true, playbackReady: true, searchResultIds: tracks.map(t => t.id),
  searchResultArtists: ["孙燕姿"], searchResultTracks: tracks, interface: { theme: "night", scene: "night", particles: 2, lyrics: "cinematic", panel: "dj" } });

test("mixed-language explicit artist preference and especially song list pass verified scope checks", () => {
  for (const request of [call("artist", "孙燕姿"), ...tracks.map(track => call("track", track.id))])
    assert.equal(agent.validateCodioToolCall(request, policy(text)), null);
  assert.equal(agent.validateCodioToolCall({ id: "p", name: "control_playback", arguments: { action: "play" } }, policy(text)), "PLAYBACK_REQUIRES_USER_INTENT");
  assert.equal(agent.validateCodioToolCall(call("track", "invented"), policy(text)), "TRACK_ID_NOT_FROM_THIS_TURN");
});

test("English scope support does not turn a single song, negation, quote, question or temporary desire into an artist preference", () => {
  for (const userText of ["I love 风衣", "I don't love 孙燕姿's music", "She said I love 孙燕姿's music", "Do I love 孙燕姿's music?", "Tonight I love 孙燕姿's music", "I love 孙燕姿's music, but don't save this preference"])
    assert.equal(agent.validateCodioToolCall(call("artist", "孙燕姿"), policy(userText)), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT", userText);
  assert.equal(agent.validateCodioToolCall(call("track", tracks[0].id), policy("I love 孙燕姿's music, especially not 风衣")), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT");
});

test("model failure preserves stable error distinctions without exposing raw Electron errors", () => {
  for (const [code, phrase] of [["CODIO_MODEL_TIMEOUT", "超时"], ["CODIO_MODEL_NETWORK", "无法连接"], ["CODIO_MODEL_UNAUTHORIZED", "认证"],
    ["CODIO_MODEL_PAYMENT_REQUIRED", "余额"], ["CODIO_MODEL_RATE_LIMITED", "受限"], ["CODIO_CONTEXT_TOO_LARGE", "上限"]]) {
    const message = agent.codioRequestFailure(new Error(`Error invoking remote method 'codio:ai-step': Error: ${code}`));
    assert.ok(message.includes(phrase)); assert.match(message, /没有执行任何操作/); assert.doesNotMatch(message, /remote method|CODIO_/);
  }
});

test("a natural model answer cannot claim saved preferences or changed recommendations without any tool result", async () => {
  const result = await agent.runCodioAgentLoop({ messages: [{ role: "user", content: text }], context: () => ({}),
    step: async () => ({ content: "已记下你的偏好，推荐队列已经更新了。", toolCalls: [] }), execute: async () => { throw Error("must not execute"); } });
  assert.match(result.content, /没有操作生效/);
  assert.doesNotMatch(result.content, /已记下你的偏好|已经更新了/);
});

test("completed hidden queue is observed after preference save, while an older refresh cannot upgrade queued facts", async () => {
  for (const revision of [4, 6]) {
    let round = 0;
    const result = await agent.runCodioAgentLoop({ messages: [{ role: "user", content: text }],
      context: () => ({ recommendations: { latestUpdate: { status: "completed", revision, hiddenQueueCommitted: true } } }),
      step: async () => { if (round++) throw Error("network"); return { content: "", toolCalls: [call("track", tracks[0].id)] }; },
      execute: async () => ({ ok: true, persisted: true, profileUpdated: true, targetType: "track", title: "风衣", value: "more", recommendationEffect: "queued", recommendationUpdate: { status: "queued", revision: 5, hiddenQueueCommitted: false } }),
    });
    assert.equal(result.successfulActions, 1);
    assert.match(result.content, revision >= 5 ? /未展示的推荐队列已提交/ : /尚未确认队列提交/);
    assert.match(result.content, /不会重复执行/);
  }
});

test("production context remains within the wire limit with a large library profile and full feature snapshots", async () => {
  const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "buildCodioContext") declaration = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(declaration);
  const affinity = Object.fromEntries(Array.from({ length: 849 }, (_, i) => [`Fixture artist ${i}`, i / 849]));
  const layer = { artistAffinities: affinity, tagAffinities: affinity, evidenceCount: 1000, distinctTrackCount: 849 };
  const profile = { lifetimeProfile: layer, recentProfile: layer, sessionProfile: layer,
    contextualProfiles: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`context-${i}`, { ...layer, reliability: .6 }])),
    confidence: "growing", hypotheses: [], recentEffects: [], sessionIntent: null };
  const context = { listeningMemoryRef: { current: { trackMemories: {}, corrections: [] } }, deriveListeningProfile: () => profile,
    activeQQTrackLiveRef: { current: null }, playQueueRef: { current: [] }, activeQueueIndexRef: { current: 0 }, musicAudioRef: { current: null },
    recommendationScoresRef: { current: new Map() }, recommendationUpdateRef: { current: { latest: { status: "completed", revision: 3, lanes: [{ lane: "match", status: "completed", privateLargeCandidateExport: "x".repeat(100000) }] } } },
    activePreferences: () => Array.from({ length: 100 }, (_, i) => ({ targetType: "track", targetKey: `fixture-${i}`, title: `Track ${i}`, value: "more", features: { huge: "x".repeat(100000) } })),
    matchedExperiments: [], visibleExperiments: [], volumeRef: { current: 30 }, seamlessRef: { current: true }, progress: 0,
    qqConnection: "connected", qqTasteSnapshotRef: { current: null }, timeContext: {}, weatherContext: {}, scene: "night", particleLevel: 2, lyricMode: "cinematic", nowPlayingOpen: false };
  const factory = new Function("context", `with(context){ ${compile(`const ${declaration};`)} return buildCodioContext(); }`);
  const snapshot = factory(context);
  assert.ok(JSON.stringify(snapshot).length < 15000);
  assert.equal(Object.keys(snapshot.listening.lifetimeProfile.artistAffinities).length, 8);
  assert.equal(snapshot.listening.activeFeedbackScopes.length, 12);
  assert.equal(snapshot.listening.activeFeedbackScopes[0].features, undefined);
  assert.equal(snapshot.recommendations.latestUpdate.lanes[0].privateLargeCandidateExport, undefined);
});
