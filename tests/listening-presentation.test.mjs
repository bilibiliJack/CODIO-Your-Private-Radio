import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const load = async file => {
  const result = await build({ entryPoints: [new URL(file, import.meta.url).pathname.slice(1)], bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
};
const [presentation, intelligence] = await Promise.all([load("../app/listening-presentation.ts"), load("../app/listening-intelligence.ts")]);
const NOW = Date.UTC(2026, 9, 2, 12);
const empty = () => ({ ...intelligence.createEmptyListeningMemory(NOW), currentSession: { sessionId: "current", startedAt: NOW - 1000 } });
const play = (id, ratio = .9, reason = "ended", at = NOW, artist = "Beach House") => ({
  type: "play_settled", eventId: `listen-${id}-${at}`, sessionId: "current", trackKey: `qq:${id}`, provider: "qq", providerTrackId: id,
  title: `Track ${id}`, artist, startedAt: at - 240000 * ratio, settledAt: at, listenedSeconds: 240 * ratio, durationSeconds: 240,
  completionRatio: ratio, exitReason: reason, source: "recommendation_match", metadataConfidence: .9,
});
const preference = (id, value = "more", at = NOW + 1, extra = {}) => ({
  type: "preference_changed", eventId: `feedback-${id}-${at}`, targetType: "track", targetKey: `qq:${id}`, value, scope: "track",
  title: `Track ${id}`, artist: "Beach House", source: "player", createdAt: at, sessionId: "current", ...extra,
});
const memoryWith = (...events) => events.reduce((memory, event) => intelligence.recordListeningEvent(memory, event), empty());
const show = (memory, options = {}) => presentation.buildListeningPresentation(memory, intelligence.deriveListeningProfile(memory, options.now ?? NOW + 100), { now: NOW + 100, ...options });

test("empty and timestamp-only render changes do not fabricate evidence or a personality", () => {
  const memory = empty();
  const before = show(memory), later = show(memory, { now: NOW + 100000 });
  assert.equal(before.lastEvidenceAt, 0);
  assert.deepEqual(later, before);
  assert.equal(before.stats.effectiveListens, 0);
  assert.equal(before.artistComparison.status, "insufficient");
  assert.equal(before.recommendation.status, "unconfirmed");
  assert.match(before.summary, /真实收听和明确反馈/);
  assert.equal(before.lifetimeArtists.length, 0);
});

test("effective listens, learning signals, retained early skips and current likes remain distinct", () => {
  const memory = memoryWith(play("neutral", .3), play("complete"), play("skip", .1, "skip"), play("error", .95, "error"),
    play("attempt", .001, "skip"), preference("complete"), preference("artist", "less", NOW + 2, { targetType: "artist", targetKey: "Other Artist", scope: "artist" }));
  const view = show(memory);
  assert.equal(view.stats.effectiveListens, 2);
  assert.equal(view.stats.settledPlays, 4);
  assert.equal(view.stats.completedListens, 1);
  assert.equal(view.stats.earlySkips, 1);
  assert.equal(view.stats.activeLikes, 1);
  assert.equal(view.stats.activeDislikes, 0, "artist feedback is not a disliked song");
  assert.equal(view.stats.activeFeedback, 2);
  assert.equal(view.stats.retainedSettlements, 4);
  assert.equal(view.recentListening.find(row => row.trackKey === "qq:neutral").effective, true);
  assert.match(view.recentListening.find(row => row.trackKey === "qq:attempt").outcomeLabel, /不计有效收听/);
  assert.equal(view.recentListening.some(row => row.trackKey === "qq:error"), false);
});

test("real feedback and withdrawal change summary, retain IDs, and remove withdrawn active counts", () => {
  const liked = memoryWith(preference("CaseSensitive", "more", NOW + 1, { reason: "recommendation_card" }));
  const likedView = show(liked);
  assert.match(likedView.summary, /多听一点「Track CaseSensitive」/);
  assert.equal(likedView.recentFeedback[0].targetKey, "qq:CaseSensitive");
  assert.equal(likedView.recentFeedback[0].sourceLabel, "推荐卡片");
  assert.equal(likedView.recentFeedback[0].createdAt, NOW + 1);
  const withdrawn = intelligence.recordListeningEvent(liked, preference("CaseSensitive", "neutral", NOW + 2));
  const view = show(withdrawn);
  assert.notEqual(view.summary, likedView.summary);
  assert.match(view.summary, /已撤回/);
  assert.equal(view.stats.activeLikes, 0);
  assert.equal(view.recentFeedback.every(row => row.state === "withdrawn" && !row.active), true);
  assert.equal(view.lastEvidenceAt, NOW + 2);
  assert.equal(view.recentFeedback[0].eventId, "feedback-CaseSensitive-" + (NOW + 2));
});

test("superseded and expired session feedback cannot continue to describe current preference", () => {
  const superseded = show(memoryWith(preference("same"), preference("same", "less", NOW + 2)));
  assert.equal(superseded.stats.activeLikes, 0);
  assert.equal(superseded.stats.activeDislikes, 1);
  assert.equal(superseded.recentFeedback[1].state, "superseded");
  assert.match(superseded.summary, /少听一点/);
  const expired = show(memoryWith(preference("expired", "more", NOW - 19 * 3600000, { scope: "session" })));
  assert.equal(expired.recentFeedback[0].state, "expired");
  assert.equal(expired.recentFeedback[0].active, false);
  assert.equal(expired.stats.activeFeedback, 0);
  assert.doesNotMatch(expired.summary, /多听一点/);
  const caseDistinct = show(memoryWith(preference("Case"), preference("case", "less", NOW + 2)));
  assert.equal(caseDistinct.stats.activeFeedback, 2, "provider IDs are case sensitive");
});

test("actual effective listening drives the summary even without an implicit preference signal", () => {
  const view = show(memoryWith(play("neutral-evidence", .3), { type: "manual_intent", eventId: "search", sessionId: "current", action: "search", query: "unplayed", createdAt: NOW + 10 }));
  assert.match(view.summary, /Track neutral-evidence/);
  assert.match(view.summary, /不等于明确喜欢/);
  assert.equal(view.lastEvidenceAt, NOW, "manual search and memory.updatedAt are not settled evidence");
  assert.equal(view.recentListening[0].sourceLabel, "贴合推荐");
  assert.equal(view.recentListening[0].eventId, "listen-neutral-evidence-" + NOW);
});

test("newer listening replaces older explicit feedback; search, pause-equivalent render and error do not", () => {
  const memory = memoryWith(preference("older-like", "more", NOW - 10000), play("newer-listen", .3, "ended", NOW));
  const actual = show(memory);
  assert.match(actual.summary, /newer-listen/);
  assert.doesNotMatch(actual.summary, /older-like/);
  const noisy = memoryWith(preference("older-like", "more", NOW - 10000), play("newer-listen", .3, "ended", NOW), play("error", .9, "error", NOW + 50),
    { type: "manual_intent", eventId: "newer-search", sessionId: "current", action: "search", query: "never heard", createdAt: NOW + 70 });
  assert.equal(show(noisy).summary, actual.summary);
  assert.equal(show(noisy).lastEvidenceAt, NOW);
  assert.equal(show(noisy, { now: NOW + 50000 }).summary, actual.summary, "pause does not add a settlement");
  const latestFeedback = intelligence.recordListeningEvent(memory, preference("latest-dislike", "less", NOW + 10));
  assert.match(show(latestFeedback).summary, /latest-dislike/);
});

test("a newer real correction or active session intent is presented as user input, not audio measurement", () => {
  const correction = { type: "profile_corrected", eventId: "reject-actual", hypothesisId: "artist-example", verdict: "reject", createdAt: NOW + 10 };
  const corrected = memoryWith(play("listen"), correction);
  assert.match(show(corrected).summary, /不太对/);
  assert.match(show(corrected).summary, /不是新测得的声音结论/);
  assert.equal(show(corrected).lastEvidenceAt, correction.createdAt);
  const intent = intelligence.createSessionIntent({ familiarity: "explore", energy: "calm", flow: "continuous" }, NOW + 20);
  const intentMemory = intelligence.recordListeningEvent(corrected, { type: "session_intent_changed", eventId: "intent-actual", sessionId: "current", intent, createdAt: NOW + 20 });
  const active = show(intentMemory);
  assert.match(active.summary, /更多新方向/);
  assert.match(active.summary, /会过期的会话选择/);
  assert.match(active.summary, /不代表声音特征已测得/);
  assert.equal(active.lastEvidenceAt, NOW + 20);
  const expired = show(intentMemory, { now: intent.expiresAt + 1 });
  assert.doesNotMatch(expired.summary, /本次会话想听/);
  assert.equal(expired.lastEvidenceAt, NOW + 20, "expiry does not invent a new event timestamp");
});

test("compacted settlements retain confirmed totals, while legacy unknown listens remain uncertain", () => {
  let memory = memoryWith(play("compacted"));
  for (let index = 0; index < intelligence.MAX_RAW_EVENTS; index++) memory = intelligence.recordListeningEvent(memory, { type: "manual_intent", eventId: `search-${index}`, sessionId: "current", action: "search", createdAt: NOW + 10 });
  const compacted = show(memory);
  assert.equal(compacted.stats.retainedSettlements, 0);
  assert.equal(compacted.stats.effectiveListens, 1);
  assert.equal(compacted.stats.completedListens, 1);
  assert.equal(compacted.lastEvidenceAt, NOW);
  assert.match(compacted.summary, /Beach House/);
  memory.trackMemories["qq:legacy"] = { trackKey: "qq:legacy", title: "Legacy", artist: "Legacy Artist", settledPlayCount: 40, playCount: 40,
    completionCount: 0, replayCount: 0, listenedSeconds: 100, firstSeenAt: NOW - 100000, lastSeenAt: NOW - 10000 };
  const legacy = show(memory);
  assert.equal(legacy.stats.effectiveListens, 1);
  assert.equal(legacy.stats.legacyUncertainTracks, 1);
  assert.match(legacy.limitations.join(" "), /只显示可确认的部分/);
  const retained = intelligence.recordListeningEvent(memory, play("legacy", .3));
  delete retained.trackMemories["qq:legacy"].effectivePlayCount;
  const partial = show(retained);
  assert.equal(partial.stats.effectiveListens, 2);
  assert.equal(partial.stats.legacyUncertainTracks, 1, "one recovered listen cannot establish forty old settlements");
});

test("recent versus lifetime artist differences use the existing evidence layers, not audio claims", () => {
  const events = [];
  for (let index = 0; index < 12; index++) events.push(play(`old-${index}`, .9, "ended", NOW - 120 * 86400000, "Longtime Artist"));
  for (let index = 0; index < 5; index++) events.push(play(`recent-${index}`, .9, "ended", NOW - index * 1000, "Recent Artist"));
  const memory = memoryWith(...events), profile = intelligence.deriveListeningProfile(memory, NOW + 100), view = show(memory);
  assert.equal(view.artistComparison.status, "different");
  assert.equal(view.lifetimeArtists[0].name, "Longtime Artist");
  assert.equal(view.recentArtists[0].name, "Recent Artist");
  assert.equal(view.lifetimeArtists[0].score, profile.lifetimeProfile.artistAffinities["longtime artist"]);
  assert.equal("confidence" in view.lifetimeArtists[0], false, "do not invent per-artist confidence");
  assert.match(view.artistComparison.summary, /不是固定人格/);
  assert.equal(show(memoryWith(play("one"))).artistComparison.status, "insufficient");
});

test("recommendation presentation distinguishes saved evidence, pending, actual commit, failure and stale results", () => {
  const memory = memoryWith(preference("queue"));
  assert.equal(show(memory, { recommendationUpdate: { status: "queued" } }).recommendation.status, "queued");
  const candidates = show(memory, { recommendationUpdate: { status: "completed" } }).recommendation;
  assert.equal(candidates.label, "候选重排已完成");
  assert.match(candidates.detail, /没有已提交/);
  assert.match(candidates.detail, /无法确认是否已覆盖最新反馈/);
  const committed = show(memory, { recommendationUpdate: { status: "completed", hiddenQueueCommitted: true, visibleBatchPreserved: true,
    lanes: [{ status: "completed", profileVersion: memory.updatedAt }] } }).recommendation;
  assert.equal(committed.label, "后续队列已更新");
  assert.match(committed.detail, /当前展示的歌曲保持不变/);
  const stale = show(memory, { recommendationUpdate: { status: "completed", hiddenQueueCommitted: true, profileVersion: memory.updatedAt - 1 } }).recommendation;
  assert.equal(stale.status, "superseded");
  assert.doesNotMatch(stale.detail, /已有后续播放队列提交/);
  assert.equal(show(memory, { recommendationUpdate: { status: "failed" } }).recommendation.status, "failed");
});

test("completed diagnostic freshness follows actual learning, not manual intent, errors or neutral listening", () => {
  const base = memoryWith(preference("learned", "more", NOW));
  const update = { status: "completed", profileVersion: NOW, hiddenQueueCommitted: true };
  let memory = intelligence.recordListeningEvent(base, { type: "manual_intent", eventId: "just-search", sessionId: "current", action: "search", createdAt: NOW + 10 });
  memory = intelligence.recordListeningEvent(memory, play("error-no-learning", .9, "error", NOW + 20));
  memory = intelligence.recordListeningEvent(memory, play("neutral-no-learning", .3, "ended", NOW + 30));
  assert.equal(show(memory, { recommendationUpdate: update }).recommendation.status, "completed");
  assert.equal(show(memory).lastEvidenceAt, NOW + 30, "effective neutral listens are real evidence but not preference learning");
  memory = intelligence.recordListeningEvent(memory, play("skip-learning", .1, "skip", NOW + 40));
  assert.equal(show(memory, { recommendationUpdate: update }).recommendation.status, "superseded");
});

test("homepage stays companionable for sparse listening without changing the factual Profile summary", () => {
  const emptyView = show(empty()), partial = show(memoryWith(play("partial", .3))), complete = show(memoryWith(play("complete", .9)));
  assert.match(emptyView.companionLine, /自己的节奏/);
  assert.equal(partial.companionLine, emptyView.companionLine, "one partial listen is not a habit or a song-by-song log");
  assert.match(complete.companionLine, /听了大半/);
  assert.doesNotMatch(complete.companionLine, /喜欢这首|你喜欢|最爱|心情|低落|平静|温柔/);
  assert.equal(complete.summary, "最近有效听过「Track complete」 · Beach House；这是收听证据，不等于明确喜欢。");
  for (const view of [emptyView, partial, complete]) assert.doesNotMatch(view.companionLine, /证据|已记为长期|不等于|测量|测得|已更新|已重排/);
});

test("homepage recognizes repeated listening without turning it into a like or an artist judgment", () => {
  const once = show(memoryWith(play("return", .3, "ended", NOW - 1000)));
  const repeated = show(memoryWith(play("return", .3, "ended", NOW - 1000), play("return", .3, "ended", NOW)));
  assert.notEqual(repeated.companionLine, once.companionLine);
  assert.match(repeated.companionLine, /Track return.*不止一次/);
  assert.doesNotMatch(repeated.companionLine, /你喜欢|最爱|Beach House|梦幻|温柔/);
  assert.equal(repeated.stats.activeLikes, 0);
});

test("homepage describes a repeated artist direction only after multiple sustained listens", () => {
  const sparse = show(memoryWith(play("one-artist")));
  assert.doesNotMatch(sparse.companionLine, /Beach House/);
  const events = Array.from({ length: 5 }, (_, index) => play(`sustained-${index}`, .9, "ended", NOW - index * 1000));
  const habitual = show(memoryWith(...events));
  assert.match(habitual.companionLine, /Beach House 的几首歌.*听了大半/);
  assert.doesNotMatch(habitual.companionLine, /证据|喜欢这位|最爱的歌手|声音都|温柔|梦幻/);
  const timeOnly = show(memoryWith(...events), { now: NOW + 60000 });
  assert.equal(timeOnly.companionLine, habitual.companionLine);
});

test("homepage only names a music style supported by repeated reliable provider metadata", () => {
  const feature = (eligible, source) => ({ value: "genre:neo-soul", source, confidence: .9, profileEligible: eligible });
  const events = (eligible, source) => Array.from({ length: 5 }, (_, index) => ({ ...play(`genre-${index}`, .9, "ended", NOW - index * 1000, `Artist ${index}`),
    features: { provider: "qq", trackId: `genre-${index}`, artist: `Artist ${index}`, tags: [feature(eligible, source)] } }));
  const reliable = show(memoryWith(...events(true, "provider_metadata")));
  assert.match(reliable.companionLine, /几首 neo-soul.*听了大半/);
  const unverified = show(memoryWith(...events(false, "artist_hint")));
  assert.doesNotMatch(unverified.companionLine, /neo-soul|音色|声音|温柔|情绪/);
  const lessStyle = show(memoryWith(...events(true, "provider_metadata"), preference("style-less", "less", NOW - 500, { targetType: "feature", targetKey: "genre:neo-soul", scope: "style" }), play("after-style-less", .9, "ended", NOW + 1, "Other")));
  assert.doesNotMatch(lessStyle.companionLine, /几首 neo-soul/);
});

test("homepage like, less and withdrawal remain song-specific and cannot imply a queue was committed", () => {
  const liked = show(memoryWith(preference("precise")));
  assert.match(liked.companionLine, /想多听一点「Track precise」/);
  const less = show(memoryWith(preference("precise", "less")));
  assert.match(less.companionLine, /想少听一点「Track precise」/);
  assert.match(less.companionLine, /这一首/);
  assert.doesNotMatch(less.companionLine, /Beach House|这位歌手|这种曲风|已经跳过|不会再放|队列/);
  const afterLessPlay = show(memoryWith(preference("precise", "less", NOW - 1000), play("precise")));
  assert.match(afterLessPlay.companionLine, /想少听一点「Track precise」/);
  const withdrawn = show(memoryWith(preference("precise"), preference("precise", "neutral", NOW + 2)));
  assert.match(withdrawn.companionLine, /反馈撤回了/);
  assert.doesNotMatch(withdrawn.companionLine, /想多听|想少听|你喜欢|重新喜欢|队列|推荐已/);
});

test("homepage does not retain superseded or expired wishes, and unchanged rendering cannot rotate copy", () => {
  const expires = memoryWith(preference("only-session", "more", NOW - 19 * 3600000, { scope: "session" }));
  assert.doesNotMatch(show(expires).companionLine, /only-session|多听一点/);
  const superseded = memoryWith(preference("changed", "more", NOW), preference("changed", "less", NOW + 1));
  assert.match(show(superseded).companionLine, /少听一点/);
  assert.doesNotMatch(show(superseded).companionLine, /多听一点/);
  const habitual = memoryWith(play("stable", .9, "ended", NOW - 1000), play("stable", .9, "ended", NOW));
  const line = show(habitual).companionLine;
  const noise = intelligence.recordListeningEvent(habitual, { type: "manual_intent", eventId: "unheard-search", sessionId: "current", action: "search", createdAt: NOW + 10 });
  const error = intelligence.recordListeningEvent(noise, play("not-heard", .9, "error", NOW + 20));
  assert.equal(show(error).companionLine, line);
  assert.equal(show(habitual, { now: NOW + 100000 }).companionLine, line);
  assert.equal(show(habitual).companionLine, line);
});

test("homepage responds naturally to real tonight wishes and corrections without pretending to apply sound changes", () => {
  const intent = intelligence.createSessionIntent({ familiarity: "explore", energy: "calm", flow: "continuous" }, NOW);
  const memory = memoryWith({ type: "session_intent_changed", eventId: "companion-tonight", sessionId: "current", intent, createdAt: NOW });
  const view = show(memory);
  assert.match(view.companionLine, /今晚想往新方向走走、平静一点、衔接顺一点/);
  assert.match(view.companionLine, /这次听歌/);
  assert.doesNotMatch(view.companionLine, /你现在很|声音.*平静|推荐.*调整|已经|测得|证据/);
  assert.doesNotMatch(show(memory, { now: intent.expiresAt + 1 }).companionLine, /今晚想/);
  const corrected = show(memoryWith({ type: "profile_corrected", eventId: "companion-correct", hypothesisId: "artist-example", verdict: "reject", createdAt: NOW }));
  assert.match(corrected.companionLine, /刚才那句没说对/);
  assert.doesNotMatch(corrected.companionLine, /证据|測量|测得/);
});

test("homepage can notice a supported recent versus lifetime artist change without treating scores as play counts", () => {
  const events = [];
  for (let index = 0; index < 12; index++) events.push(play(`habit-old-${index}`, .9, "ended", NOW - 120 * 86400000, "Longtime Artist"));
  for (let index = 0; index < 5; index++) events.push(play(`habit-new-${index}`, .9, "ended", NOW - index * 1000, "Recent Artist"));
  const view = show(memoryWith(...events));
  assert.match(view.companionLine, /Longtime Artist.*Recent Artist/);
  assert.match(view.companionLine, /新的一边/);
  assert.doesNotMatch(view.companionLine, /最多|最爱|声音|情绪|心情|证据/);
});
