import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../app/listening-intelligence.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const NOW = Date.UTC(2026, 9, 6, 5);
const unknown = () => ({ value: null, source: "audio_analysis", confidence: 0, profileEligible: false });
// Isolated metadata and listening events test policy, not any real song's sound.
function candidate(id, artist, album, genres = ["genre:neo-soul"]) {
  return { canonicalKey: `qq:${id}`, track: { provider: "qq", id, title: id, artist, ...(album ? { album } : {}) },
    source: "adjacent_discovery", generationReason: "isolated gradual fixture", sourceConfidence: .95,
    alreadyHeard: false, inLibrary: false, alreadyRecommended: false, playable: true,
    featureVector: { provider: "qq", trackId: id, artist, ...(album ? { album } : {}),
      tags: genres.map(value => ({ value, source: "provider_metadata", confidence: .65, profileEligible: true })),
      bpm: unknown(), energy: unknown(), vocalFocus: unknown(), instrumentalFocus: unknown(), transitionFocus: unknown(),
      inLibrary: false, likedInProvider: false, artistFamiliarity: 0, playlistMembership: [], playCount: 0,
      novelty: { value: .8, source: "library_behavior", confidence: .8, profileEligible: false }, metadataConfidence: .95 } };
}
function preference(memory, targetType, targetKey, extras = {}) {
  return api.recordListeningEvent(memory, { type: "preference_changed", eventId: `preference-${memory.rawEvents.length}`,
    targetType, targetKey, value: "more", scope: targetType === "artist" ? "artist" : "track", source: "dj",
    createdAt: NOW, sessionId: memory.currentSession.sessionId, ...extras });
}
function like(memory, item) {
  return preference(memory, "track", item.canonicalKey, { title: item.track.title, artist: item.track.artist, features: item.featureVector });
}
function listen(memory, id, artist, ratio = .9, exitReason = "ended") {
  const item = candidate(id, artist, undefined, []);
  return api.recordListeningEvent(memory, { type: "play_settled", eventId: `settled-${id}`,
    sessionId: memory.currentSession.sessionId, trackKey: item.canonicalKey, provider: "qq", providerTrackId: id,
    title: id, artist, features: item.featureVector, startedAt: NOW - 240 * ratio * 1000, settledAt: NOW,
    listenedSeconds: 240 * ratio, durationSeconds: 240, completionRatio: ratio, exitReason, source: "queue", metadataConfidence: .95 });
}
const anchored = () => like(api.createEmptyListeningMemory(NOW), candidate("anchor", "Anchor artist"));
const score = (item, memory, lane = "match") => api.scoreCandidate(item, api.deriveListeningProfile(memory, NOW), memory, lane, NOW);
const scores = (items, memory = anchored(), lane = "match") => new Map(items.map(item => [item.canonicalKey, score(item, memory, lane)]));
const explicitWeight = memory => score(candidate("unheard", "Requested artist", undefined, []), memory).contributions.find(item => item.key === "explicit_artist").signedWeight;
const artistCounts = items => items.reduce((counts, item) => counts.set(item.track.artist, (counts.get(item.track.artist) || 0) + 1), new Map());

test("one unheard artist expression is a small nudge, not a strength-tier override", () => {
  const memory = preference(anchored(), "artist", "Requested artist");
  assert.equal(explicitWeight(memory), .2);
  const requested = candidate("requested", "Requested artist"), established = candidate("established", "Other artist");
  const ranked = scores([requested, established], memory);
  assert.equal(ranked.get(requested.canonicalKey).laneEvidence.match, true);
  assert.equal(ranked.get(established.canonicalKey).laneEvidence.match, true);
  assert.equal(ranked.get(requested.canonicalKey).laneEvidence.strength, ranked.get(established.canonicalKey).laneEvidence.strength);
  // Hold the candidate scores fixed: stronger admission evidence is not a
  // second hard ranking tier that can defeat an actually higher total score.
  ranked.set(requested.canonicalKey, { ...ranked.get(requested.canonicalKey), totalScore: .7,
    laneEvidence: { ...ranked.get(requested.canonicalKey).laneEvidence, strength: .95 } });
  ranked.set(established.canonicalKey, { ...ranked.get(established.canonicalKey), totalScore: 1.2 });
  assert.equal(api.composeRecommendations([requested, established], ranked, "match", 2)[0].canonicalKey, established.canonicalKey);
});

test("real completed songs strengthen the explicit nudge gradually and stay capped", () => {
  let memory = preference(anchored(), "artist", "Requested artist");
  const weights = [explicitWeight(memory)];
  for (let index = 0; index < 12; index++) {
    memory = listen(memory, `real-${index}`, "Requested artist");
    const behavior = api.deriveListeningProfile(memory, NOW).lifetimeProfile.artistAffinities["requested artist"] - .85;
    const weight = explicitWeight(memory);
    assert.ok(Math.abs(weight - Math.min(.45, .2 + Math.max(0, behavior) * .06)) < 1e-10);
    assert.equal(api.listeningStatus(memory, `qq:real-${index}`, NOW).effective, true);
    const evidence = score(candidate("related-unheard", "Requested artist"), memory).laneEvidence;
    assert.equal(evidence.match, true);
    assert.equal(evidence.frontier, false);
    weights.push(weight);
  }
  assert.ok(weights[1] > weights[0]);
  assert.ok(weights[4] > weights[1]);
  assert.equal(weights.at(-1), .45);
  let ineffective = preference(anchored(), "artist", "Requested artist");
  ineffective = listen(ineffective, "zero-start", "Requested artist", 0, "switch");
  ineffective = listen(ineffective, "failed-start", "Requested artist", .02, "error");
  assert.equal(explicitWeight(ineffective), .2);
});

test("repeating the same expression does not stack weight or surviving artist facts", () => {
  const once = preference(anchored(), "artist", "Requested artist");
  let repeated = once;
  for (let index = 0; index < 5; index++) repeated = preference(repeated, "artist", "Requested artist", { createdAt: NOW + index + 1 });
  assert.equal(api.activePreferences(repeated, NOW + 6).filter(event => event.targetType === "artist").length, 1);
  assert.equal(explicitWeight(repeated), explicitWeight(once));
  assert.equal(api.deriveListeningProfile(repeated, NOW + 6).lifetimeProfile.artistAffinities["requested artist"], .85);
  const withdrawn = preference(repeated, "artist", "Requested artist", { value: "neutral", createdAt: NOW + 7 });
  assert.equal(explicitWeight(withdrawn), 0);
  assert.equal(api.deriveListeningProfile(withdrawn, NOW + 7).lifetimeProfile.artistAffinities["requested artist"], undefined);
});

test("each six-card page spreads artists while real lane qualification still excludes unrelated music", () => {
  const items = Array.from({ length: 6 }, (_, artist) => Array.from({ length: 4 }, (_, track) =>
    candidate(`spread-${artist}-${track}`, `Artist ${artist}`, `Album ${artist}-${track}`))).flat();
  const unrelated = candidate("unrelated", "Unknown artist", "Unrelated album", ["genre:death-metal"]);
  const ranked = scores([...items, unrelated]);
  for (const item of items) ranked.set(item.canonicalKey, { ...ranked.get(item.canonicalKey), totalScore: 10 - Number(item.track.artist.at(-1)) });
  ranked.set(unrelated.canonicalKey, { ...ranked.get(unrelated.canonicalKey), totalScore: 100 });
  assert.equal(ranked.get(unrelated.canonicalKey).laneEvidence.match, false);
  const selected = api.composeRecommendations([...items, unrelated], ranked, "match", 12);
  assert.equal(selected.length, 12);
  assert.equal(selected.includes(unrelated), false);
  assert.ok([...artistCounts(selected).values()].every(count => count <= 2));
  for (let start = 0; start < 12; start += 6) {
    const page = selected.slice(start, start + 6);
    assert.ok(artistCounts(page).size >= 4);
    assert.ok(artistCounts(page.slice(0, 4)).size >= 4, "find four eligible artists before taking a second work");
    assert.ok([...artistCounts(page).values()].every(count => count <= 2));
  }
});

test("known albums do not repeat on a page, while missing albums do not create a guessed group", () => {
  const items = Array.from({ length: 6 }, (_, artist) => Array.from({ length: 2 }, (_, track) =>
    candidate(`album-${artist}-${track}`, `Artist ${artist}`, "Shared album name"))).flat();
  items.push(...Array.from({ length: 6 }, (_, artist) => candidate(`other-${artist}`, `Artist ${artist}`, `Other album ${artist}`)));
  const ranked = scores(items);
  for (const item of items) ranked.set(item.canonicalKey, { ...ranked.get(item.canonicalKey),
    totalScore: item.track.album === "Shared album name" ? 10 - Number(item.track.artist.at(-1)) : 1 });
  const selected = api.composeRecommendations(items, ranked, "match", 12);
  assert.equal(selected.length, 12);
  for (let start = 0; start < 12; start += 6) {
    const page = selected.slice(start, start + 6);
    assert.equal(new Set(page.map(item => `${item.track.artist}:${item.featureVector.album}`)).size, page.length);
  }
  assert.equal(selected.filter(item => item.track.album === "Shared album name").length, 12,
    "same title on different artists and the same album on a different page are not forbidden");
  const unknownAlbums = Array.from({ length: 12 }, (_, index) => candidate(`no-album-${index}`, `Artist ${index % 6}`));
  assert.equal(api.composeRecommendations(unknownAlbums, scores(unknownAlbums), "match", 12).length, 12);
});

test("long hidden composition keeps six-card artist bounds without globally limiting artists to two", () => {
  const items = Array.from({ length: 12 }, (_, artist) => Array.from({ length: 12 }, (_, track) =>
    candidate(`hidden-${artist}-${track}`, `Artist ${artist}`, `Album ${artist}-${track}`))).flat();
  const ranked = scores(items);
  const selected = api.composeRecommendations(items, ranked, "match", 120, { maxPerArtist: 12 });
  assert.equal(selected.length, 120);
  assert.ok([...artistCounts(selected).values()].every(count => count > 2));
  for (let start = 0; start < selected.length; start += 6) {
    const page = selected.slice(start, start + 6);
    assert.ok(artistCounts(page).size >= 4);
    assert.ok([...artistCounts(page).values()].every(count => count <= 2));
  }
  assert.ok([...ranked.values()].every(item => Number.isFinite(item.totalScore)));
  const penalties = [...ranked.values()].flatMap(item => item.contributions.filter(part => part.key === "composition_diversity"));
  assert.ok(penalties.length > 0);
  assert.ok(penalties.every(part => part.signedWeight >= -2), "long queues cannot accrue unbounded composition penalties");
});

test("composing the same mutable scores twice is idempotent, including actual flow contributions", () => {
  const items = Array.from({ length: 18 }, (_, index) => candidate(`stable-${index}`, `Artist ${index % 6}`, `Album ${index}`));
  for (const item of items) item.featureVector.bpm = { value: 90, source: "audio_analysis", confidence: .8, profileEligible: true };
  const ranked = scores(items);
  const options = { maxPerArtist: 3, flow: "continuous" };
  const first = api.composeRecommendations(items, ranked, "match", 12, options).map(item => item.canonicalKey);
  const afterFirst = structuredClone([...ranked]);
  assert.ok(afterFirst.some(([, item]) => item.contributions.some(part => part.key === "session_flow")));
  assert.ok(afterFirst.some(([, item]) => item.contributions.some(part => part.key === "composition_diversity")));
  const second = api.composeRecommendations(items, ranked, "match", 12, options).map(item => item.canonicalKey);
  assert.deepEqual(second, first);
  assert.deepEqual([...ranked], afterFirst);
  for (const item of ranked.values()) for (const key of ["composition_diversity", "session_flow"])
    assert.ok(item.contributions.filter(part => part.key === key).length <= 1);
});

test("artist, style and anchor seeds interleave and eight fixed seeds each cover all twelve refresh pages", () => {
  let memory = api.createEmptyListeningMemory(NOW);
  for (let index = 0; index < 3; index++) memory = like(memory,
    candidate(`seed-${index}`, `Seed artist ${index}`, undefined, [index === 2 ? "genre:synth-pop" : "genre:neo-soul"]));
  const profile = api.deriveListeningProfile(memory, NOW);
  const first = api.recommendationAcquisitionSeeds("match", memory, profile, { cursor: 0, limit: 8, now: NOW });
  assert.equal(first.length, 8);
  assert.equal(new Set(first.slice(0, 3).map(seed => seed.strategy)).size, 3);
  const pages = new Map(first.map(seed => [seed.key, new Set()]));
  for (let refresh = 0; refresh < 12; refresh++) {
    const batch = api.recommendationAcquisitionSeeds("match", memory, profile, { cursor: refresh * 8, limit: 8, now: NOW });
    assert.equal(batch.length, 8);
    assert.deepEqual(new Set(batch.map(seed => seed.key)), new Set(first.map(seed => seed.key)));
    for (const seed of batch) pages.get(seed.key).add(seed.page);
  }
  for (const [key, seen] of pages) assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1), key);
});
