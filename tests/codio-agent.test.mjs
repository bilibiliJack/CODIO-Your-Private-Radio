import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const dir = new URL("../.test-build/codio-agent/", import.meta.url);
const output = new URL("codio-agent.mjs", dir);
let run;
let validate;
let isOffline;
let didStart;
let verifyNamedTrack;
before(async () => { await mkdir(dir, { recursive: true }); await build({ entryPoints: [new URL("../app/codio-agent.ts", import.meta.url).pathname.slice(1)], outfile: output.pathname.slice(1), bundle: true, platform: "node", format: "esm", logLevel: "silent" }); ({ runCodioAgentLoop: run, validateCodioToolCall: validate, isOfflineCodioShortcut: isOffline, didRequestedTrackStart: didStart, verifyNamedTrackPreference: verifyNamedTrack } = await import(`${output.href}?${Date.now()}`)); });
after(async () => rm(dir, { recursive: true, force: true }));

const user = [{ role: "user", content: "暂停" }];
test("tool loop returns a read-only answer without executing", async () => { let calls = 0; const result = await run({ messages: user, context: () => ({}), step: async () => ({ content: "现在没有播放。", toolCalls: [] }), execute: async () => { calls += 1; return { ok: true }; } }); assert.equal(calls, 0); assert.equal(result.content, "现在没有播放。"); });
test("tool result is sent back before the final natural response is retained", async () => { let round = 0; const result = await run({ messages: user, context: () => ({ round }), step: async (messages) => round++ ? ({ content: `完成:${messages.at(-1).role}`, toolCalls: [] }) : ({ content: "", toolCalls: [{ id: "1", name: "control_playback", arguments: { action: "pause" } }] }), execute: async () => ({ ok: true, before: true, after: false }) }); assert.equal(result.messages.at(-1).role, "tool"); assert.equal(result.content, "完成:tool"); assert.equal(result.executedActions, 1); });
test("unknown tools can be rejected without counting as successful", async () => { const result = await run({ messages: user, maxRounds: 1, context: () => ({}), step: async () => ({ content: "", toolCalls: [{ id: "x", name: "unknown", arguments: {} }] }), execute: async () => ({ ok: false, error: "UNKNOWN_TOOL" }) }); assert.equal(result.executedActions, 1); assert.match(result.content, /没有|没能/); });
test("the loop caps actions at six", async () => { let count = 0; const result = await run({ messages: user, maxRounds: 2, maxActions: 6, context: () => ({}), step: async () => ({ content: "", toolCalls: Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: "x", arguments: {} })) }), execute: async () => { count += 1; return { ok: true }; } }); assert.equal(count, 6); assert.equal(result.executedActions, 6); });
test("the loop caps model round trips at four", async () => { let rounds = 0; await run({ messages: user, context: () => ({}), step: async () => { rounds += 1; return { content: "", toolCalls: [{ id: String(rounds), name: "x", arguments: {} }] }; }, execute: async () => ({ ok: false }) }); assert.equal(rounds, 4); });
test("network failure after a successful tool never repeats the action", async () => { let rounds = 0; let executions = 0; const result = await run({ messages: user, context: () => ({}), step: async () => { if (rounds++) throw new Error("offline"); return { content: "", toolCalls: [{ id: "1", name: "pause", arguments: {} }] }; }, execute: async () => { executions += 1; return { ok: true }; } }); assert.equal(executions, 1); assert.match(result.content, /不会重复执行/); });

test("duplicate tool_call_id executes once and returns a structured rejection", async () => {
  let executions = 0;
  const result = await run({ messages: user, maxRounds: 2, context: () => ({}), step: async () => ({ content: "", toolCalls: [{ id: "same", name: "control_playback", arguments: { action: "pause" } }] }), execute: async () => { executions += 1; return { ok: true }; } });
  assert.equal(executions, 1);
  assert.equal(result.attemptedActions, 2);
  assert.equal(result.successfulActions, 1);
  assert.match(result.messages.at(-1).content, /DUPLICATE_TOOL_CALL_ID/);
  const assistantIds = result.messages.filter(({ role }) => role === "assistant").flatMap(({ toolCalls = [] }) => toolCalls.map(({ id }) => id));
  assert.equal(new Set(assistantIds).size, assistantIds.length, "duplicate model IDs must be remapped before the next IPC request");
  assert.equal(result.messages.at(-1).toolCallId, assistantIds.at(-1));
});

test("tool exceptions become TOOL_EXECUTION_FAILED and do not escape to fallback", async () => {
  let rounds = 0;
  const result = await run({ messages: user, context: () => ({}), step: async () => rounds++ ? ({ content: "真实失败已收到", toolCalls: [] }) : ({ content: "", toolCalls: [{ id: "boom", name: "control_playback", arguments: { action: "pause" } }] }), execute: async () => { throw new Error("renderer failed"); } });
  assert.equal(result.attemptedActions, 1);
  assert.equal(result.successfulActions, 0);
  assert.match(result.messages.at(-1).content, /TOOL_EXECUTION_FAILED/);
  assert.match(result.content, /本地操作失败/);
});

test("attempted and successful action counts stay separate", async () => {
  let round = 0;
  const result = await run({ messages: user, context: () => ({}), step: async () => round++ ? ({ content: "done", toolCalls: [] }) : ({ content: "", toolCalls: [{ id: "ok", name: "x", arguments: {} }, { id: "no", name: "x", arguments: {} }] }), execute: async (call) => ({ ok: call.id === "ok" }) });
  assert.equal(result.attemptedActions, 2);
  assert.equal(result.successfulActions, 1);
});

test("a tool exception followed by a model failure resolves locally instead of escaping", async () => {
  let rounds = 0;
  const result = await run({
    messages: user,
    context: () => ({}),
    step: async () => {
      if (rounds++) throw new Error("offline");
      return { content: "", toolCalls: [{ id: "failed", name: "control_playback", arguments: { action: "pause" } }] };
    },
    execute: async () => { throw new Error("renderer failed"); },
  });
  assert.equal(result.attemptedActions, 1);
  assert.equal(result.successfulActions, 0);
  assert.match(result.content, /本地操作失败/);
  assert.doesNotMatch(result.content, /TOOL_EXECUTION_FAILED/);
});

test("the first model failure still escapes so the caller may use a safe offline shortcut", async () => {
  await assert.rejects(() => run({ messages: user, context: () => ({}), step: async () => { throw new Error("offline"); }, execute: async () => ({ ok: true }) }), /offline/);
});

test("hitting the action limit never returns an unverified model success claim", async () => {
  let round = 0;
  const result = await run({
    messages: user,
    maxActions: 1,
    context: () => ({}),
    step: async () => round++
      ? ({ content: "全部已经完成", toolCalls: [{ id: "2", name: "control_playback", arguments: { action: "play" } }] })
      : ({ content: "", toolCalls: [{ id: "1", name: "control_playback", arguments: { action: "pause" } }] }),
    execute: async () => ({ ok: true, after: "paused" }),
  });
  assert.doesNotMatch(result.content, /全部已经完成/);
  assert.match(result.content, /已执行刚才的本地操作/);
  assert.equal(result.attemptedActions, 1);
});

test("fresh context is generated before every model round trip", async () => {
  let value = 0;
  const contexts = [];
  await run({
    messages: user,
    context: () => ({ value: value += 1 }),
    step: async (_messages, context) => {
      contexts.push(context);
      return contexts.length === 1
        ? { content: "", toolCalls: [{ id: "1", name: "control_playback", arguments: { action: "pause" } }] }
        : { content: "done", toolCalls: [] };
    },
    execute: async () => ({ ok: true }),
  });
  assert.deepEqual(contexts, [{ value: 1 }, { value: 2 }]);
});

test("invalid executor results are converted into structured failures", async () => {
  let round = 0;
  const result = await run({
    messages: user,
    context: () => ({}),
    step: async () => round++
      ? ({ content: "收到失败结果", toolCalls: [] })
      : ({ content: "", toolCalls: [{ id: "1", name: "control_playback", arguments: { action: "pause" } }] }),
    execute: async () => null,
  });
  assert.equal(result.successfulActions, 0);
  assert.match(result.messages.at(-1).content, /TOOL_RESULT_INVALID/);
});

const policy = (overrides = {}) => ({
  qqConnected: true,
  playbackReady: true,
  searchResultIds: ["allowed"],
  userText: "",
  interface: { theme: "night", scene: "night", particles: 2, lyrics: "cinematic", panel: "close" },
  ...overrides,
});
const call = (name, args = {}) => ({ id: "1", name, arguments: args });

test("instrumental preference accepts explicit first-person lasting choices without QQ", () => {
  for (const [userText, value] of [
    ["我不喜欢纯音乐", "less"], ["我最近不太喜欢听纯音乐", "less"],
    ["我讨厌器乐曲", "less"], ["我对纯音乐不喜欢", "less"],
    ["我喜欢纯音乐", "more"], ["本人一直偏爱无人声的音乐", "more"],
    ["I don't like instrumental music.", "less"], ["I prefer instrumentals", "more"],
  ]) {
    assert.equal(validate(call("record_music_preference", { target_type: "feature", feature_key: "instrumental", value }), policy({ userText, qqConnected: false, playbackReady: false, searchResultIds: [] })), null, userText);
  }
});

test("category permission rejects questions, quotations, third-person and temporary intent", () => {
  for (const userText of [
    "我不喜欢纯音乐吗？", "你觉得我不喜欢纯音乐？", "如果我不喜欢纯音乐怎么办",
    "朋友说我不喜欢纯音乐", "他说：我不喜欢纯音乐", "“我不喜欢纯音乐”这句话是什么意思",
    "今晚我不喜欢纯音乐", "我现在不喜欢纯音乐", "我不喜欢纯音乐，但不要记录偏好",
    "我不是不喜欢纯音乐", "我不喜欢这首歌", "纯音乐好听吗", "别把我记成不喜欢纯音乐",
    "I dislike instrumental music tonight", "She said, I don't like instrumental music.",
  ]) {
    assert.equal(validate(call("record_music_preference", { target_type: "feature", feature_key: "instrumental", value: "less" }), policy({ userText })), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT", userText);
  }
  assert.equal(validate(call("record_music_preference", { target_type: "feature", feature_key: "instrumental", value: "more" }), policy({ userText: "我不喜欢纯音乐" })), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT");
});

test("instrumental category contract rejects unknown categories and cross-scope arguments", () => {
  for (const arguments_ of [
    { target_type: "feature", feature_key: "vocal", value: "less" },
    { target_type: "feature", value: "less" },
    { target_type: "feature", feature_key: "instrumental", value: "less", track_id: "current" },
    { target_type: "feature", feature_key: "instrumental", value: "less", artist_name: "Someone" },
    { target_type: "feature", feature_key: "instrumental", value: "less", scope: "session" },
  ]) assert.equal(validate(call("record_music_preference", arguments_), policy({ userText: "我不喜欢纯音乐" })), "INVALID_PREFERENCE_FEATURE");
  assert.equal(validate(call("rate_current_track", { rating: "dislike" }), policy({ userText: "我不喜欢纯音乐" })), "RATING_REQUIRES_EXPLICIT_USER_INTENT");
  assert.equal(validate(call("control_playback", { action: "pause" }), policy({ userText: "我不喜欢纯音乐" })), "PLAYBACK_REQUIRES_USER_INTENT");
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "allowed", value: "more", feature_key: "instrumental" }), policy({ userText: "我喜欢这首" })), "INVALID_TOOL_ARGUMENTS");
  assert.equal(validate(call("record_music_preference", { target_type: "artist", artist_name: "Known", value: "more", feature_key: "instrumental" }), policy({ userText: "我喜欢 Known" })), "INVALID_TOOL_ARGUMENTS");
});

test("category result reaches the model and a grounded final reply is not overwritten", async () => {
  let rounds = 0, executions = 0;
  const final = "记下了，你不喜欢纯音乐。画像已保存，后续推荐重排已排队；现在展示的歌曲不变。";
  const result = await run({ messages: [{ role: "user", content: "我不喜欢纯音乐" }], context: () => ({}),
    step: async messages => {
      if (!rounds++) return { content: "", toolCalls: [call("record_music_preference", { target_type: "feature", feature_key: "instrumental", value: "less" })] };
      const observed = JSON.parse(messages.at(-1).content);
      assert.equal(observed.targetKey, "instrumental"); assert.equal(observed.recommendationEffect, "queued");
      return { content: final, toolCalls: [] };
    }, execute: async () => { executions += 1; return { ok: true, targetType: "feature", targetKey: "instrumental", value: "less", persisted: true, profileUpdated: true, recommendationEffect: "queued" }; },
  });
  assert.equal(result.content, final); assert.equal(executions, 1);
});

test("category network fallback names the category, not a fabricated song, without replay", async () => {
  let rounds = 0, executions = 0;
  const result = await run({ messages: [{ role: "user", content: "我不喜欢纯音乐" }], context: () => ({}),
    step: async () => { if (rounds++) throw new Error("offline"); return { content: "", toolCalls: [call("record_music_preference", { target_type: "feature", feature_key: "instrumental", value: "less" })] }; },
    execute: async () => { executions += 1; return { ok: true, targetType: "feature", targetKey: "instrumental", value: "less", persisted: true, profileUpdated: true, recommendationEffect: "queued" }; },
  });
  assert.equal(executions, 1); assert.match(result.content, /不喜欢 纯音乐/); assert.match(result.content, /尚未确认队列提交/);
  assert.doesNotMatch(result.content, /已核对的歌曲|《|\{"ok"/);
});

test("natural replies cannot turn queued recommendations into a committed result", async () => {
  let round = 0;
  const result = await run({ messages: [{ role: "user", content: "我不喜欢纯音乐" }], context: () => ({}),
    step: async () => round++ ? { content: "已经更新了推荐队列，马上全换好了。", toolCalls: [] } : { content: "", toolCalls: [call("record_music_preference", { target_type: "feature", feature_key: "instrumental", value: "less" })] },
    execute: async () => ({ ok: true, targetType: "feature", targetKey: "instrumental", value: "less", persisted: true, profileUpdated: true, recommendationEffect: "queued", recommendationUpdate: { hiddenQueueCommitted: false } }),
  });
  assert.doesNotMatch(result.content, /马上全换好了|已经更新了推荐队列/); assert.match(result.content, /尚未确认队列提交/);
});

test("a saved preference cannot become an unconfirmed profile update in natural reply", async () => {
  let round = 0;
  const result = await run({ messages: [{ role: "user", content: "我不喜欢纯音乐" }], context: () => ({}),
    step: async () => round++ ? { content: "画像已经更新，都会生效了。", toolCalls: [] } : { content: "", toolCalls: [call("record_music_preference", { target_type: "feature", feature_key: "instrumental", value: "less" })] },
    execute: async () => ({ ok: true, targetType: "feature", targetKey: "instrumental", value: "less", persisted: true, profileUpdated: false, recommendationEffect: "queued" }),
  });
  assert.doesNotMatch(result.content, /都会生效了|画像已经更新/); assert.match(result.content, /画像或推荐更新还没有得到确认/);
});

test("unsupported category errors are specific while truthful model explanation survives", async () => {
  let round = 0;
  const result = await run({ messages: [{ role: "user", content: "我不喜欢摇滚" }], context: () => ({}),
    step: async () => round++ ? { content: "目前还不能可靠地记录这个音乐分类，可以先告诉我具体歌曲。", toolCalls: [] } : { content: "", toolCalls: [call("record_music_preference", { target_type: "feature", feature_key: "rock", value: "less" })] },
    execute: async () => ({ ok: false, error: "INVALID_PREFERENCE_FEATURE" }),
  });
  assert.match(result.content, /目前还不能可靠地记录/); assert.match(result.content, /偏好没有保存/); assert.doesNotMatch(result.content, /有一步操作没能确认生效|INVALID_/);
});

test("offline fallback accepts only explicit safe local controls", () => {
  assert.equal(isOffline("暂停"), true);
  assert.equal(isOffline("音量调到30"), true);
  assert.equal(isOffline("我今天很难过"), false);
  assert.equal(isOffline("帮我找首歌"), false);
});

test("volume policy enforces absolute and relative bounds", () => {
  assert.equal(validate(call("adjust_volume", { operation: "set", value: 100 }), policy()), null);
  assert.equal(validate(call("adjust_volume", { operation: "set", value: 101 }), policy()), "INVALID_VOLUME");
  assert.equal(validate(call("adjust_volume", { operation: "set", value: "50" }), policy()), "INVALID_VOLUME");
  assert.equal(validate(call("adjust_volume", { operation: "increase", value: 30 }), policy()), null);
  assert.equal(validate(call("adjust_volume", { operation: "decrease", value: 31 }), policy()), "INVALID_VOLUME");
});

test("search policy rejects invalid requests but works before playback is ready", () => {
  assert.equal(validate(call("search_music", { query: " ", limit: 5 }), policy()), "INVALID_SEARCH_QUERY");
  assert.equal(validate(call("search_music", { query: "x".repeat(121), limit: 5 }), policy()), "INVALID_SEARCH_QUERY");
  assert.equal(validate(call("search_music", { query: "song", limit: 11 }), policy()), "INVALID_SEARCH_LIMIT");
  assert.equal(validate(call("search_music", { query: "song", limit: 5 }), policy({ qqConnected: false })), "QQ_NOT_CONNECTED");
  assert.equal(validate(call("search_music", { query: "song", limit: 5 }), policy({ playbackReady: false })), null);
});

test("search-result playback is limited to this turn whitelist", () => {
  assert.equal(validate(call("play_search_result", { track_id: "allowed" }), policy({ userText: "播放这首" })), null);
  assert.equal(validate(call("play_search_result", { track_id: "unknown" }), policy({ userText: "播放这首" })), "TRACK_ID_NOT_FROM_THIS_TURN");
  assert.equal(validate(call("play_search_result", { track_id: "allowed" }), policy({ searchResultIds: [], userText: "播放这首" })), "TRACK_ID_NOT_FROM_THIS_TURN");
  assert.equal(validate(call("play_search_result", { track_id: "allowed" }), policy({ qqConnected: false, userText: "播放这首" })), "QQ_NOT_CONNECTED");
  assert.equal(validate(call("play_search_result", { track_id: "allowed" }), policy({ playbackReady: false, userText: "播放这首" })), "QQ_PLAYBACK_NOT_READY");
  assert.equal(validate(call("play_search_result", { track_id: "allowed" }), policy({ userText: "我很喜欢这首" })), "PLAYBACK_REQUIRES_USER_INTENT");
});

test("search-result playback reports success only after the requested track really starts", () => {
  assert.equal(didStart(true, "wanted", "wanted", false), true);
  assert.equal(didStart(false, "wanted", "wanted", false), false);
  assert.equal(didStart(true, "wanted", "other", false), false);
  assert.equal(didStart(true, "wanted", "wanted", true), false);
  assert.equal(didStart(true, "wanted", "wanted", undefined), false);
});

test("remaining tool policies reject malformed parameters", () => {
  assert.equal(validate(call("control_playback", { action: "stop" }), policy()), "INVALID_ACTION");
  assert.equal(validate(call("seek_playback", { position_percent: 40 }), policy()), null);
  assert.equal(validate(call("seek_playback", { position_percent: "40" }), policy()), "INVALID_SEEK");
  assert.equal(validate(call("seek_playback", { position_percent: 101 }), policy()), "INVALID_SEEK");
  assert.equal(validate(call("set_seamless", { enabled: true }), policy()), null);
  assert.equal(validate(call("set_seamless", { enabled: "true" }), policy()), "INVALID_SEAMLESS");
  assert.equal(validate(call("refresh_recommendations"), policy({ userText: "刷新推荐" })), null);
  assert.equal(validate(call("refresh_recommendations"), policy({ userText: "我喜欢 Daniel 的歌" })), "REFRESH_REQUIRES_USER_INTENT");
  assert.equal(validate(call("refresh_recommendations", { force: true }), policy()), "INVALID_RECOMMENDATION_REFRESH");
  assert.equal(validate({ id: "1", name: "control_playback", arguments: [] }, policy()), "INVALID_TOOL_ARGUMENTS");
});

test("interface policy rejects empty, invalid, and no-op updates", () => {
  assert.equal(validate(call("update_interface", {}), policy()), "INVALID_INTERFACE_UPDATE");
  assert.equal(validate(call("update_interface", { theme: "white" }), policy()), "INVALID_THEME");
  assert.equal(validate(call("update_interface", { scene: "space" }), policy()), "INVALID_SCENE");
  assert.equal(validate(call("update_interface", { particles: 3 }), policy()), "INVALID_PARTICLES");
  assert.equal(validate(call("update_interface", { lyrics: "fade" }), policy()), "INVALID_LYRICS");
  assert.equal(validate(call("update_interface", { panel: "billing" }), policy()), "INVALID_PANEL");
  assert.equal(validate(call("update_interface", { theme: "night" }), policy()), "INTERFACE_ALREADY_IN_REQUESTED_STATE");
  assert.equal(validate(call("update_interface", { theme: "day" }), policy()), "INVALID_THEME");
});

test("ratings require explicit direction and unknown tools are rejected", () => {
  assert.equal(validate(call("rate_current_track", { rating: "like" }), policy({ userText: "这首很好听" })), null);
  assert.equal(validate(call("rate_current_track", { rating: "like" }), policy({ userText: "我不喜欢这首" })), "RATING_REQUIRES_EXPLICIT_USER_INTENT");
  assert.equal(validate(call("rate_current_track", { rating: "like" }), policy({ userText: "我不是很喜欢这首" })), "RATING_REQUIRES_EXPLICIT_USER_INTENT");
  assert.equal(validate(call("rate_current_track", { rating: "like" }), policy({ userText: "你觉得我会喜欢这首吗？" })), "RATING_REQUIRES_EXPLICIT_USER_INTENT");
  assert.equal(validate(call("rate_current_track", { rating: "dislike" }), policy({ userText: "我不喜欢这首" })), null);
  assert.equal(validate(call("rate_current_track", { rating: "dislike" }), policy({ userText: "不要标记为不喜欢" })), "RATING_REQUIRES_EXPLICIT_USER_INTENT");
  assert.equal(validate(call("rate_current_track", { rating: "dislike" }), policy({ userText: "换一首" })), "RATING_REQUIRES_EXPLICIT_USER_INTENT");
  assert.equal(validate(call("remove_key"), policy()), "UNKNOWN_TOOL");
});

test("Daniel preference can be verified and saved without playback permission", () => {
  const state = policy({
    userText: "我最近特别喜欢 Daniel 的 Valentina 和 Always，其他他的歌也挺好听",
    searchResultIds: ["valentina-id", "always-id"],
    searchResultArtists: ["Daniel"],
    searchResultTracks: [{ id: "valentina-id", title: "Valentina", artist: "Daniel" }, { id: "always-id", title: "Always", artist: "Daniel" }],
  });
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "valentina-id", value: "more" }), state), null);
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "always-id", value: "more" }), state), null);
  assert.equal(validate(call("record_music_preference", { target_type: "artist", artist_name: "Daniel", value: "more" }), state), null);
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "invented-id", value: "more" }), state), "TRACK_ID_NOT_FROM_THIS_TURN");
  assert.equal(validate(call("record_music_preference", { target_type: "artist", artist_name: "Other", value: "more" }), state), "ARTIST_NOT_FROM_THIS_TURN");
  assert.equal(validate(call("play_search_result", { track_id: "valentina-id" }), state), "PLAYBACK_REQUIRES_USER_INTENT");
  assert.equal(validate(call("control_playback", { action: "play" }), state), "PLAYBACK_REQUIRES_USER_INTENT");
  assert.equal(validate(call("control_playback", { action: "play" }), policy({ userText: "我没有要求播放" })), "PLAYBACK_REQUIRES_USER_INTENT");
  assert.equal(validate(call("control_playback", { action: "play" }), policy({ userText: "我喜欢现在播放的这首" })), "PLAYBACK_REQUIRES_USER_INTENT");
  assert.equal(validate(call("control_playback", { action: "next" }), policy({ userText: "下一首是什么？" })), "PLAYBACK_REQUIRES_USER_INTENT");
  assert.equal(validate(call("rate_current_track", { rating: "like" }), state), "RATING_REQUIRES_EXPLICIT_USER_INTENT");
});

test("one song's negative feedback cannot become an artist dislike", () => {
  const state = policy({
    userText: "我不喜欢 Daniel 的 Valentina，但 Always 还挺好听",
    searchResultIds: ["valentina-id", "always-id"],
    searchResultArtists: ["Daniel"],
    searchResultTracks: [{ id: "valentina-id", title: "Valentina", artist: "Daniel" }, { id: "always-id", title: "Always", artist: "Daniel" }],
  });
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "valentina-id", value: "less" }), state), null);
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "always-id", value: "more" }), state), null);
  assert.equal(validate(call("record_music_preference", { target_type: "artist", artist_name: "Daniel", value: "less" }), state), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT");
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "always-id", value: "less" }), state), "PREFERENCE_REQUIRES_EXPLICIT_USER_INTENT");
});

test("temporary intent is separate from named long-term preference", () => {
  const state = policy({ userText: "今晚想听安静一点的新歌" });
  assert.equal(validate(call("set_session_intent", { energy: "calm", familiarity: "explore" }), state), null);
  assert.equal(validate(call("set_session_intent", { energy: "calm" }), policy({ userText: "Daniel 的歌怎么样？" })), "SESSION_INTENT_REQUIRES_USER_INTENT");
  assert.equal(validate(call("record_music_preference", { target_type: "artist", artist_name: "Daniel", value: "more" }), state), "ARTIST_NOT_FROM_THIS_TURN");
});

test("search success followed by rejected playback never claims preference was saved", async () => {
  let round = 0;
  const result = await run({
    messages: [{ role: "user", content: "我最近特别喜欢 Daniel 的 Valentina" }],
    context: () => ({}),
    step: async () => round++ ? { content: "偏好已经调整", toolCalls: [] } : { content: "", toolCalls: [
      call("search_music", { query: "Daniel Valentina" }),
      { id: "2", name: "play_search_result", arguments: { track_id: "valentina-id" } },
    ] },
    execute: async ({ name }) => name === "search_music"
      ? { ok: true, results: [{ track_id: "valentina-id", title: "Valentina", artist: "Daniel" }] }
      : { ok: false, error: "PLAYBACK_REQUIRES_USER_INTENT" },
  });
  assert.match(result.content, /没有动播放状态/);
  assert.doesNotMatch(result.content, /偏好已经调整|\{"ok"/);
});

test("verified preferences report saved facts after model disconnect without replaying tools", async () => {
  let rounds = 0;
  let executions = 0;
  const result = await run({
    messages: [{ role: "user", content: "我喜欢 Daniel 的 Valentina" }],
    context: () => ({}),
    step: async () => {
      if (rounds++) throw new Error("offline");
      return { content: "", toolCalls: [{ id: "1", name: "record_music_preference", arguments: { target_type: "track", track_id: "valentina-id", value: "more" } }] };
    },
    execute: async () => { executions += 1; return { ok: true, targetType: "track", title: "Valentina", artist: "Daniel", value: "more", persisted: true, profileUpdated: true, recommendationEffect: "pending_queue" }; },
  });
  assert.equal(executions, 1);
  assert.match(result.content, /Valentina/);
  assert.match(result.content, /后续推荐/);
  assert.match(result.content, /不会重复执行/);
  assert.doesNotMatch(result.content, /\{"ok"/);
});

test("real QQ title suffix and Daniel Caesar prefix verify the named song, not unrelated results", () => {
  const userText = "我最近特别喜欢 Daniel 的 Valentina 和 Always，其他他的歌也挺好听";
  const results = [
    { id: "dime", title: "Dime Dime", artist: "Luna" },
    { id: "valentina", title: "Valentina", artist: "Daniel Caesar" },
    { id: "valentina-other", title: "Valentina", artist: "Another Artist" },
    { id: "always", title: "Always (Explicit)", artist: "Daniel Caesar" },
    { id: "always-other", title: "Always", artist: "Bon Jovi" },
  ];
  const state = policy({ userText, searchResultIds: results.map(({ id }) => id), searchResultArtists: results.map(({ artist }) => artist), searchResultTracks: results });
  assert.equal(verifyNamedTrack(userText, results[1], results), null);
  assert.equal(verifyNamedTrack(userText, results[3], results), null);
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "valentina", value: "more" }), state), null);
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "always", value: "more" }), state), null);
  assert.equal(validate(call("record_music_preference", { target_type: "artist", artist_name: "Daniel Caesar", value: "more" }), state), null);
  assert.equal(validate(call("record_music_preference", { target_type: "track", track_id: "dime", value: "more" }), state), "TRACK_NOT_NAMED_BY_USER");
  assert.notEqual(validate(call("record_music_preference", { target_type: "track", track_id: "valentina-other", value: "more" }), state), null);
  assert.notEqual(validate(call("record_music_preference", { target_type: "track", track_id: "always-other", value: "more" }), state), null);
});

test("ambiguous Daniel prefix and collaboration versions require clarification", () => {
  const userText = "我喜欢 Daniel 的 Always，其他他的歌也不错";
  const solo = { id: "solo", title: "Always (Explicit)", artist: "Daniel Caesar" };
  const samePrefix = { id: "other-daniel", title: "Always", artist: "Daniel Smith" };
  const collaboration = { id: "collab", title: "Always", artist: "Daniel Caesar & H.E.R." };
  assert.equal(verifyNamedTrack(userText, solo, [solo, samePrefix]), "AMBIGUOUS_TRACK");
  assert.equal(verifyNamedTrack(userText, solo, [solo, collaboration]), "AMBIGUOUS_TRACK");
  assert.notEqual(verifyNamedTrack(userText, collaboration, [collaboration]), null);
  const state = policy({ userText, searchResultIds: [solo.id, samePrefix.id], searchResultArtists: [solo.artist, samePrefix.artist], searchResultTracks: [solo, samePrefix] });
  assert.equal(validate(call("record_music_preference", { target_type: "artist", artist_name: "Daniel Caesar", value: "more" }), state), "AMBIGUOUS_ARTIST");
});

test("two title-only searches then three preferences finish within four rounds and six tools", async () => {
  const userText = "我最近特别喜欢 Daniel 的 Valentina 和 Always，其他他的歌也挺好听";
  const valentina = { id: "valentina", title: "Valentina", artist: "Daniel Caesar" };
  const always = { id: "always", title: "Always (Explicit)", artist: "Daniel Caesar" };
  const found = [];
  const executed = [];
  let rounds = 0;
  const result = await run({
    messages: [{ role: "user", content: userText }],
    context: () => ({}), maxRounds: 4, maxActions: 6,
    step: async (messages) => {
      rounds += 1;
      if (rounds === 1) return { content: "", toolCalls: [
        { id: "search-v", name: "search_music", arguments: { query: "Valentina" } },
        { id: "search-a", name: "search_music", arguments: { query: "Always" } },
      ] };
      if (rounds === 2) {
        assert.equal(messages.filter(({ role }) => role === "tool").length, 2);
        return { content: "", toolCalls: [
          { id: "pref-v", name: "record_music_preference", arguments: { target_type: "track", track_id: "valentina", value: "more" } },
          { id: "pref-a", name: "record_music_preference", arguments: { target_type: "track", track_id: "always", value: "more" } },
          { id: "pref-artist", name: "record_music_preference", arguments: { target_type: "artist", artist_name: "Daniel Caesar", value: "more" } },
        ] };
      }
      return { content: "done", toolCalls: [] };
    },
    execute: async (tool) => {
      executed.push(tool.name);
      if (tool.name === "search_music") {
        const item = tool.arguments.query === "Valentina" ? valentina : always;
        found.push(item);
        return { ok: true, results: [{ track_id: item.id, title: item.title, artist: item.artist }] };
      }
      const state = policy({ userText, searchResultIds: found.map(({ id }) => id), searchResultArtists: found.map(({ artist }) => artist), searchResultTracks: found });
      const error = validate(tool, state);
      if (error) return { ok: false, error };
      const item = found.find(({ id }) => id === tool.arguments.track_id);
      return { ok: true, targetType: tool.arguments.target_type, title: item?.title, artist: item?.artist || "Daniel Caesar", value: "more", persisted: true, profileUpdated: true, recommendationEffect: "pending_queue" };
    },
  });
  assert.equal(rounds, 3);
  assert.equal(result.attemptedActions, 5);
  assert.equal(result.successfulActions, 5);
  assert.deepEqual(executed, ["search_music", "search_music", "record_music_preference", "record_music_preference", "record_music_preference"]);
  assert.match(result.content, /Valentina/);
  assert.match(result.content, /Always/);
  assert.match(result.content, /Daniel Caesar/);
});
