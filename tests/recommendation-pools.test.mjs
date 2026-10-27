import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../app/listening-intelligence.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const NOW = Date.UTC(2026, 9, 2, 5);
const unknown = () => ({ value: null, source: "audio_analysis", confidence: 0, profileEligible: false });
// This file tests acquisition ownership/scheduling with isolated metadata, not
// real music-similarity claims. The separate public-QQ runner audits real IDs.
function candidate(id, artist = `Artist ${id}`, genre = "genre:neo-soul", extras = {}) {
  return { canonicalKey: `qq:${id}`, track: { provider: "qq", id, title: id, artist }, source: "adjacent_discovery",
    generationReason: "isolated own-pool retrieval", sourceConfidence: .95, alreadyHeard: false, inLibrary: false, alreadyRecommended: false, playable: true,
    featureVector: { provider: "qq", trackId: id, artist, tags: genre ? [{ value: genre, source: "provider_metadata", confidence: .65, profileEligible: true }] : [],
      bpm: unknown(), energy: unknown(), vocalFocus: unknown(), instrumentalFocus: unknown(), transitionFocus: unknown(),
      inLibrary: false, likedInProvider: false, artistFamiliarity: 0, playlistMembership: [], playCount: 0,
      novelty: { value: .8, source: "library_behavior", confidence: .8, profileEligible: false }, metadataConfidence: .95 }, ...extras };
}
function likedMemory() {
  const known = candidate("known", "Known Artist");
  return api.recordListeningEvent(api.createEmptyListeningMemory(NOW), { type: "preference_changed", eventId: "known-like", targetType: "track", targetKey: known.canonicalKey,
    value: "more", scope: "track", title: "Known Song", artist: known.track.artist, features: known.featureVector, source: "player", createdAt: NOW, sessionId: "isolated" });
}
const memory = likedMemory();
const profile = api.deriveListeningProfile(memory, NOW);
function scores(items, lane, state = memory) {
  return new Map(items.map(item => [item.canonicalKey, api.scoreCandidate(item, api.deriveListeningProfile(state, NOW), state, lane, NOW)]));
}
function begin(pool, advance = true, version = memory.updatedAt) {
  return api.beginRecommendationPoolUpdate(pool, version, advance);
}
function commit(started, items, other = api.createRecommendationPool(started.pool.lane === "match" ? "frontier" : "match"), replaceVisible = true, extras = {}) {
  return api.commitRecommendationPoolUpdate(started.pool, started.request, { candidates: items, scores: scores(items, started.pool.lane),
    otherOwnedKeys: new Set([...other.visible, ...other.hidden]), replaceVisible, profileVersion: memory.updatedAt, ...extras });
}

test("lane seeds have genuinely different acquisition goals, bounded pages and no fixed artist graph", () => {
  const match = api.recommendationAcquisitionSeeds("match", memory, profile, { now: NOW, cursor: 2 });
  const frontier = api.recommendationAcquisitionSeeds("frontier", memory, profile, { now: NOW, cursor: 7 });
  assert.ok(match.some(seed => seed.strategy === "verified_artist_works" && seed.query === "Known Artist"));
  assert.ok(match.some(seed => seed.strategy === "exact_favorite_anchor" && seed.evidenceKeys.includes("qq:known")));
  assert.ok(frontier.some(seed => seed.strategy === "adjacent_verified_style" && seed.query === "neo-soul"));
  assert.ok(frontier.every(seed => seed.excludeArtists.includes("Known Artist")));
  assert.ok(frontier.every(seed => !["verified_artist_works", "exact_favorite_anchor"].includes(seed.strategy)));
  assert.ok([...match, ...frontier].every(seed => seed.page >= 1 && seed.page <= 12));
  assert.ok(match.every(seed => seed.basis && seed.key.startsWith("match:")));
  assert.ok(frontier.every(seed => seed.basis && seed.key.startsWith("frontier:")));
  const empty = api.createEmptyListeningMemory(NOW);
  assert.deepEqual(api.recommendationAcquisitionSeeds("match", empty, api.deriveListeningProfile(empty, NOW), { now: NOW }), []);
  assert.deepEqual(api.recommendationAcquisitionSeeds("frontier", empty, api.deriveListeningProfile(empty, NOW), { now: NOW }), []);
});

test("artist-only, language and unverified feature priors do not manufacture adjacent seed evidence", () => {
  const weak = candidate("weak", "Actual Artist", null).featureVector;
  weak.inLibrary = true;
  weak.tags = [{ value: "language:English", source: "provider_metadata", confidence: .95, profileEligible: true },
    { value: "genre:ambient", source: "artist_hint", confidence: .9, profileEligible: false }];
  const empty = api.createEmptyListeningMemory(NOW), p = api.deriveListeningProfile(empty, NOW);
  assert.ok(api.recommendationAcquisitionSeeds("match", empty, p, { libraryFeatures: [weak], now: NOW }).some(seed => seed.query === "Actual Artist"));
  assert.deepEqual(api.recommendationAcquisitionSeeds("frontier", empty, p, { libraryFeatures: [weak], now: NOW }), []);
});

test("library artist familiarity plus broad genre is not enough to qualify a new close match", () => {
  const library = candidate("library-anchor", "Library Artist", "genre:pop").featureVector;
  library.inLibrary = true;
  const empty = api.createEmptyListeningMemory(NOW), p = api.deriveListeningProfile(empty, NOW);
  const familiar = candidate("new-library-artist", "Library Artist", "genre:pop"); familiar.featureVector.artistFamiliarity = .8;
  const adjacent = candidate("new-other-artist", "Other Artist", "genre:pop");
  const unrelated = candidate("no-library-connection", "Other Artist", "genre:techno");
  const options = { libraryFeatures: [library] };
  const score = item => api.scoreCandidate(item, p, empty, "match", NOW, options);
  assert.equal(score(familiar).laneEvidence.match, false);
  assert.equal(score(familiar).laneEvidence.frontier, true);
  assert.equal(score(adjacent).laneEvidence.match, false); assert.equal(score(adjacent).laneEvidence.frontier, true);
  assert.equal(score(unrelated).laneEvidence.frontier, false);
  assert.ok(score(adjacent).contributions.find(item => item.key === "library_style").signedWeight > 0);
  assert.ok(score(adjacent).contributions.find(item => item.key === "library_style").signedWeight < .1);
  assert.deepEqual(empty.explicitPreferences, [], "reading library evidence cannot write a new profile or duplicate preference");
  const disliked = api.recordListeningEvent(empty, { type: "preference_changed", eventId: "reject-library-song", targetType: "track", targetKey: familiar.canonicalKey,
    value: "less", scope: "track", createdAt: NOW, sessionId: empty.currentSession.sessionId });
  assert.equal(api.scoreCandidate(familiar, api.deriveListeningProfile(disliked, NOW), disliked, "match", NOW, options).laneEvidence.match, false);
});

test("already learned reliable tags do not receive a duplicate library-style vote", () => {
  const library = candidate("known", "Known Artist").featureVector; library.inLibrary = true;
  const item = candidate("another", "Other Artist");
  const value = api.scoreCandidate(item, profile, memory, "match", NOW, { libraryFeatures: [library] });
  assert.equal(value.contributions.find(item => item.key === "library_style").signedWeight, 0);
});

test("two independently collected song-level facts can support new works without claiming official likes or whole-artist similarity",()=>{
  const one=candidate("collected-one","Collected artist","genre:pop").featureVector;
  const two=candidate("collected-two","Collected artist","genre:pop").featureVector;
  one.inLibrary=true;two.inLibrary=true;
  const state=api.createEmptyListeningMemory(NOW),p=api.deriveListeningProfile(state,NOW),fresh=candidate("unheard-work","Collected artist","genre:pop");
  fresh.featureVector.artistFamiliarity=.8;
  const score=features=>api.scoreCandidate(fresh,p,state,"match",NOW,{libraryFeatures:features});
  assert.equal(score([one]).laneEvidence.match,false);assert.equal(score([one,one]).laneEvidence.match,false);
  assert.equal(score([one,two]).laneEvidence.match,true);assert.equal(score([one,two]).laneEvidence.frontier,false);
  assert.match(score([one,two]).topReasons[0],/歌单/);assert.ok(score([one,two]).laneEvidence.strength<=.55);
  assert.equal(api.scoreCandidate(candidate("different-work","Collected artist","genre:rock"),p,state,"match",NOW,{libraryFeatures:[one,two]}).laneEvidence.match,false);
  assert.equal(one.likedInProvider,false);assert.deepEqual(state.explicitPreferences,[]);
});

test("match retrieval spends its cursor on independent evidenced artists, not hundreds of tagless library entries",()=>{
  const features=Array.from({length:600},(_,i)=>{const f=candidate(`unknown-${i}`,`Unknown ${i}`,null).featureVector;f.inLibrary=true;return f;});
  for(let i=0;i<6;i++)for(let j=0;j<2;j++){const f=candidate(`collected-${i}-${j}`,`Supported ${i}`,"genre:pop").featureVector;f.inLibrary=true;features.push(f);}
  const empty=api.createEmptyListeningMemory(NOW),p=api.deriveListeningProfile(empty,NOW);
  for(const cursor of [0,8,56,96]){
    const seeds=api.recommendationAcquisitionSeeds("match",empty,p,{libraryFeatures:features,cursor,now:NOW,limit:8});
    assert.equal(seeds.length,6);assert.ok(seeds.every(seed=>seed.query.startsWith("Supported ")));
  }
});

test("own REFRESH changes only that lane's batch, exposure, cursor and request revision", () => {
  const matchItems = Array.from({ length: 30 }, (_, i) => candidate(`m${i}`));
  const frontierItems = Array.from({ length: 30 }, (_, i) => candidate(`f${i}`));
  const m = commit(begin(api.createRecommendationPool("match")), matchItems).pool;
  const f = commit(begin(api.createRecommendationPool("frontier")), frontierItems, m).pool;
  const before = JSON.stringify(f);
  const refreshed = commit(begin(m), matchItems, f).pool;
  assert.equal(refreshed.cursor, m.cursor + 1); assert.equal(refreshed.revision, m.revision + 1);
  assert.notDeepEqual(refreshed.visible, m.visible); assert.equal(refreshed.visible.length, 12);
  assert.equal(JSON.stringify(f), before); assert.equal(f.cursor, 1); assert.equal(f.visible.length, 12);
  assert.equal([...refreshed.visible, ...refreshed.hidden].some(key => [...f.visible, ...f.hidden].includes(key)), false);
});

test("display readiness gates the new page without discarding unshown owned catalogue identities", () => {
  const items=Array.from({length:36},(_,i)=>candidate(`reserve-${i}`));
  const started=begin(api.createRecommendationPool("match"));
  const checked=new Set(items.slice(12,24).map(item=>item.canonicalKey));
  const result=commit(started,items,undefined,true,{displayReadyKeys:checked});
  assert.equal(result.pool.visible.length,12);
  assert.ok(result.pool.visible.every(key=>checked.has(key)),"unchecked catalogue facts cannot become visible playable cards");
  assert.ok(result.pool.hidden.some(key=>!checked.has(key)),"hidden candidates are not the same as audio-buffered sources");
  assert.equal(result.pool.candidates.length,36);
  const partial=commit(started,items,undefined,true,{displayReadyKeys:new Set(items.slice(0,5).map(item=>item.canonicalKey))});
  assert.equal(partial.pool.visible.length,5);assert.equal(partial.pool.status,"insufficient_candidates");
});

test("partial page completion counts existing artists, albums and anchors across the whole batch", () => {
  const anchors = [candidate("a1", "Repeated artist", undefined, { inLibrary: true }), candidate("a2", "Repeated artist", undefined, { inLibrary: true })];
  const initial = [...anchors, candidate("b", "Second"), candidate("c", "Third")];
  const partial = commit(begin(api.createRecommendationPool("match")), initial).pool;
  assert.equal(partial.visible.length, 4);
  const extra = [candidate("a3", "Repeated artist"), candidate("a4", "Repeated artist"), candidate("extra-anchor", "Anchor", undefined, { inLibrary: true }),
    ...Array.from({ length: 15 }, (_, i) => candidate(`new-${i}`, `Independent ${i}`))];
  const filled = commit(begin(partial), [...initial, ...extra], undefined, false).pool;
  assert.equal(filled.visible.length, 12); assert.deepEqual(filled.visible.slice(0, 4), partial.visible);
  const byId = new Map([...initial, ...extra].map(item => [item.canonicalKey, item]));
  const actual = filled.visible.map(id => byId.get(id));
  assert.equal(actual.filter(item => item.track.artist === "Repeated artist").length, 2);
  assert.equal(actual.filter(item => item.inLibrary).length, 2);
  assert.ok(!filled.visible.includes("qq:extra-anchor"));
  for (let start = 0; start < 12; start += 6) assert.ok(new Set(actual.slice(start, start + 6).map(item => item.track.artist)).size >= 4);
});

test("independent asynchronous acquisition still completes when the other lane fails", async () => {
  const pools = { match: api.createRecommendationPool("match"), frontier: api.createRecommendationPool("frontier") };
  const calls = [];
  async function refresh(lane) {
    const started = begin(pools[lane]); pools[lane] = started.pool;
    const seed = api.recommendationAcquisitionSeeds(lane, memory, profile, { now: NOW, cursor: pools[lane].cursor })[0];
    calls.push({ lane, strategy: seed.strategy, query: seed.query });
    try {
      const own = await (lane === "match" ? Promise.reject(new Error("isolated search timeout")) : Promise.resolve(Array.from({ length: 12 }, (_, i) => candidate(`adjacent-${i}`))));
      pools[lane] = commit(started, own, pools[lane === "match" ? "frontier" : "match"]).pool;
    } catch { pools[lane] = api.failRecommendationPoolUpdate(pools[lane], started.request, "SEARCH_TIMEOUT").pool; }
  }
  await Promise.all([refresh("match"), refresh("frontier")]);
  assert.equal(calls.length, 2); assert.notEqual(calls[0].strategy, calls[1].strategy);
  assert.equal(pools.match.status, "failed"); assert.equal(pools.frontier.status, "completed");
  assert.equal(pools.frontier.visible.length, 12); assert.equal(pools.match.visible.length, 0);
});

test("visible and hidden ownership is checked at commit, preventing duplicate races", () => {
  const common = Array.from({ length: 30 }, (_, i) => candidate(`shared-${i}`));
  const matchStart = begin(api.createRecommendationPool("match"));
  const frontierStart = begin(api.createRecommendationPool("frontier"));
  const match = commit(matchStart, common).pool;
  const frontier = commit(frontierStart, common, match);
  assert.equal(frontier.pool.visible.length, 0); assert.equal(frontier.pool.hidden.length, 0);
  assert.ok(frontier.excluded.every(item => item.reason === "OWNED_BY_OTHER_POOL"));
});

test("scores alone cannot admit candidates without lane evidence or own-lane scoring", () => {
  const unrelated = candidate("no-relation", "Unknown", "genre:techno");
  const unknown = candidate("unknown", "Known Artist", null);
  for (const lane of ["match", "frontier"]) {
    const started = begin(api.createRecommendationPool(lane));
    const ownScores = scores([unrelated, unknown], lane);
    ownScores.get(unrelated.canonicalKey).totalScore = 999;
    const result = commit(started, [unrelated, unknown], undefined, true, { scores: ownScores });
    assert.deepEqual(result.pool.candidates, []);
    assert.ok(result.excluded.every(item => item.reason === "INSUFFICIENT_LANE_EVIDENCE"));
    const wrong = commit(started, [candidate("wrong")], undefined, true, { scores: scores([candidate("wrong")], lane === "match" ? "frontier" : "match") });
    assert.equal(wrong.excluded[0].reason, "MISSING_OWN_LANE_SCORE");
  }
});

test("feedback reclassifies hidden candidates only, keeping both visible batches stable", () => {
  const matchItems = Array.from({ length: 30 }, (_, i) => candidate(`m-feedback-${i}`));
  const frontierItems = Array.from({ length: 30 }, (_, i) => candidate(`f-feedback-${i}`));
  const m = commit(begin(api.createRecommendationPool("match")), matchItems).pool;
  const f = commit(begin(api.createRecommendationPool("frontier")), frontierItems, m).pool;
  const removed = m.hidden[0];
  const state = api.recordListeningEvent(memory, { type: "preference_changed", eventId: "hidden-dislike", targetType: "track", targetKey: removed,
    value: "less", scope: "track", createdAt: NOW + 1, sessionId: memory.currentSession.sessionId });
  const mStart = begin(m, false, state.updatedAt);
  const mAfter = commit(mStart, matchItems, f, false, { scores: scores(matchItems, "match", state), profileVersion: state.updatedAt }).pool;
  assert.deepEqual(mAfter.visible, m.visible); assert.deepEqual(f.visible, f.visible.slice());
  assert.equal(mAfter.hidden.includes(removed), false); assert.equal(mAfter.cursor, m.cursor);
});

test("old profile versions and old lane requests cannot overwrite newer feedback", () => {
  const pool = api.createRecommendationPool("match"); const first = begin(pool, false, 1); const second = begin(first.pool, false, 2);
  const items = Array.from({ length: 12 }, (_, i) => candidate(`stale-${i}`));
  const stale = commit({ pool: second.pool, request: first.request }, items, undefined, true, { profileVersion: 2 });
  assert.equal(stale.stale, true); assert.strictEqual(stale.pool, second.pool);
  assert.equal(api.failRecommendationPoolUpdate(second.pool, first.request, "LATE_FAILURE").stale, true);
  const latest = commit(second, items, undefined, true, { profileVersion: 2 });
  assert.equal(latest.pool.visible.length, 12);
});

test("insufficient or failed requests retain usable batches; initial partial results fill only vacancies", () => {
  const initial = commit(begin(api.createRecommendationPool("match"), false), [candidate("first")], undefined, false).pool;
  assert.deepEqual(initial.visible, ["qq:first"]); assert.equal(initial.status, "insufficient_candidates");
  const filled = commit(begin(initial, false), Array.from({ length: 12 }, (_, i) => candidate(`fill-${i}`)), undefined, false).pool;
  assert.equal(filled.visible[0], "qq:first"); assert.equal(filled.visible.length, 12);
  const notEnough = commit(begin(filled), [candidate("one-more")]).pool;
  assert.deepEqual(notEnough.visible, filled.visible); assert.equal(notEnough.status, "insufficient_candidates");
  const pending = begin(filled); const failed = api.failRecommendationPoolUpdate(pending.pool, pending.request, "SOURCE_UNAVAILABLE").pool;
  assert.deepEqual(failed.visible, filled.visible); assert.deepEqual(failed.hidden, filled.hidden);
});

test("repeated own-lane refresh consumes independent exposure instead of alternating two batches", () => {
  const items = Array.from({ length: 48 }, (_, i) => candidate(`fresh-${i}`));
  let pool = api.createRecommendationPool("match"); const seen = new Set();
  for (let round = 0; round < 4; round++) {
    pool = commit(begin(pool), items).pool;
    assert.equal(pool.visible.length, 12);
    for (const key of pool.visible) { assert.equal(seen.has(key), false); seen.add(key); }
  }
  assert.equal(seen.size, 48); assert.equal(pool.exposure.length, 48); assert.equal(pool.cursor, 4);
});
