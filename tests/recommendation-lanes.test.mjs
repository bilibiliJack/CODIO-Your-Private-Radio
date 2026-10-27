import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../app/listening-intelligence.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
// Synthetic evidence is only for deterministic policy boundaries, not a claim
// about any real song's sound. Real QQ identities are checked by the runner.
const NOW = Date.UTC(2026, 9, 1, 1);
const unknown = () => ({ value: null, source: "audio_analysis", confidence: 0, profileEligible: false });
function candidate(id, artist, genres = [], overrides = {}) {
  return { canonicalKey: `qq:${id}`, track: { provider: "qq", id, title: id, artist }, source: "adjacent_discovery",
    generationReason: "isolated policy fixture", sourceConfidence: .95, alreadyHeard: false, inLibrary: false, alreadyRecommended: false, playable: true,
    featureVector: { provider: "qq", trackId: id, artist, tags: genres.map(value => ({ value, source: "provider_metadata", confidence: .65, profileEligible: true })),
      bpm: unknown(), energy: unknown(), vocalFocus: unknown(), instrumentalFocus: unknown(), transitionFocus: unknown(),
      inLibrary: false, likedInProvider: false, artistFamiliarity: 0, playlistMembership: [], playCount: 0,
      novelty: { value: .8, source: "library_behavior", confidence: .8, profileEligible: false }, metadataConfidence: .95 }, ...overrides };
}
function like(memory, item) {
  return api.recordListeningEvent(memory, { type: "preference_changed", eventId: `like-${item.track.id}`, targetType: "track", targetKey: item.canonicalKey,
    title: item.track.title, artist: item.track.artist, features: item.featureVector, value: "more", scope: "track", source: "player", createdAt: NOW, sessionId: memory.currentSession.sessionId });
}
const anchor = candidate("known", "Known artist", ["genre:neo-soul", "language:英语"]);
const memory = like(api.createEmptyListeningMemory(NOW), anchor);

test("lane rerank rejects unqualified old tail without dropping the committed prefix",()=>{
  const queue=[{mid:"played"},{mid:"current"},{mid:"manual-next"},{mid:"promised"},{mid:"old-unrelated"}];
  const ranked=[{mid:"qualified-new"},{mid:"current"}];
  const result=api.mergeHiddenRecommendations(queue,ranked,"current",new Set(["manual-next","promised"]),false);
  assert.deepEqual(result.queue.map(x=>x.mid),["played","current","manual-next","promised","qualified-new"]);
  assert.equal(result.currentIndex,1);assert.equal(result.protectedPrefixLength,4);
});

test("evidence supplement enriches one event, never repeats its weight or revives withdrawal",()=>{
  const unknownSong=candidate("supplement","Artist");const first=like(api.createEmptyListeningMemory(),unknownSong);
  const id=api.activePreferences(first)[0].eventId;
  const features=candidate("supplement","Artist",["genre:neo-soul"]).featureVector;
  const richer=api.supplementPreferenceFeatures(first,id,features);
  assert.equal(richer.explicitPreferences.length,1);assert.equal(richer.rawEvents.length,1);assert.equal(richer.explicitPreferences[0].features.tags[0].value,"genre:neo-soul");
  assert.strictEqual(api.supplementPreferenceFeatures(richer,id,features),richer);
  const withdrawn=api.recordListeningEvent(richer,{...first.explicitPreferences[0],eventId:"withdraw",value:"neutral",createdAt:NOW+1});
  assert.strictEqual(api.supplementPreferenceFeatures(withdrawn,id,features),withdrawn);
  assert.equal(api.activePreferences(withdrawn).length,0);
});
test("flow changes actual composition with fixed candidates, only within the same eligibility tier",()=>{
  const items=[candidate("first","A",["genre:neo-soul"]),candidate("same","B",["genre:neo-soul"]),candidate("different","C",["genre:synth-pop"])];
  for(const item of items)item.featureVector.bpm={value:90,source:"audio_analysis",confidence:.8,profileEligible:true};
  const make=()=>new Map(items.map((item,index)=>[item.canonicalKey,{totalScore:index===0?10:1,contributions:[],laneEvidence:{calibrated:true,match:true,frontier:true,strength:.65}}]));
  const continuous=make(),varied=make();
  const a=api.composeRecommendations(items,continuous,"match",3,{flow:"continuous"}),b=api.composeRecommendations(items,varied,"match",3,{flow:"varied"});
  assert.equal(a[1].track.id,"same");assert.equal(b[1].track.id,"different");
  assert.ok(continuous.get("qq:same").contributions.some(x=>x.key==="session_flow"&&x.signedWeight>0));
  assert.ok(varied.get("qq:different").contributions.some(x=>x.key==="session_flow"&&x.signedWeight<0));
  const noEvidence=items.map(item=>({...item,featureVector:{...item.featureVector,tags:[],bpm:unknown()}}));const scores=make();
  api.composeRecommendations(noEvidence,scores,"match",3,{flow:"continuous"});assert.ok([...scores.values()].every(s=>!s.contributions.some(x=>x.key==="session_flow")));
});
test("official provider favorites and playlist membership are actually consumed by final score",()=>{
  const item=candidate("library-song","A");item.inLibrary=true;item.featureVector.inLibrary=true;
  const plain=api.scoreCandidate(item,api.deriveListeningProfile(api.createEmptyListeningMemory(),NOW),api.createEmptyListeningMemory(),"match",NOW);
  item.featureVector.playlistMembership=["playlist-1","playlist-2"];
  const member=api.scoreCandidate(item,api.deriveListeningProfile(api.createEmptyListeningMemory(),NOW),api.createEmptyListeningMemory(),"match",NOW);
  item.featureVector.likedInProvider=true;
  const favorite=api.scoreCandidate(item,api.deriveListeningProfile(api.createEmptyListeningMemory(),NOW),api.createEmptyListeningMemory(),"match",NOW);
  const part=s=>s.contributions.find(p=>p.key==="library_affinity").signedWeight;
  assert.ok(part(member)>part(plain));assert.ok(part(favorite)>part(member));
});
const score = (item, lane = "match", state = memory) => api.scoreCandidate(item, api.deriveListeningProfile(state, NOW), state, lane, NOW);
function compose(items, lane, state = memory) {
  const scores = new Map(items.map(item => [item.canonicalKey, score(item, lane, state)]));
  return api.composeRecommendations(items, scores, lane, 12, { maxAnchors: 2, maxPerArtist: lane === "match" ? 3 : 2 });
}

test("unheard song with specific evidenced taste can be a close match without being familiar", () => {
  const item = candidate("new-close", "Different artist", ["genre:neo-soul", "language:英语"]);
  assert.equal(item.alreadyHeard, false);
  assert.equal(score(item).laneEvidence.match, true);
  assert.equal(compose([item], "match")[0], item);
  assert.ok(score(item).contributions.find(part => part.key === "verified_track_similarity").signedWeight > 0);
});
test("novelty, identity, playability and an unrelated title cannot buy close-match admission", () => {
  const item = candidate("unrelated", "Unknown", ["genre:techno", "language:英语"]);
  const value = score(item);
  assert.ok(value.contributions.find(part => part.key === "freshness").signedWeight > 0);
  assert.equal(value.laneEvidence.match, false); assert.equal(value.laneEvidence.frontier, false);
  assert.deepEqual(compose([item], "match"), []); assert.deepEqual(compose([item], "frontier"), []);
});
test("a broad genre is an honest exploration bridge, not proof of a close sound match", () => {
  const known = candidate("pop-known", "A", ["genre:pop", "language:英语"]);
  const state = like(api.createEmptyListeningMemory(NOW), known);
  const item = candidate("pop-new", "B", ["genre:pop", "language:英语"]);
  assert.equal(score(item, "match", state).laneEvidence.match, false);
  assert.equal(score(item, "frontier", state).laneEvidence.frontier, true);
  assert.deepEqual(compose([item], "match", state), []); assert.equal(compose([item], "frontier", state)[0], item);
});
test("language alone and low-confidence genre do not qualify either lane", () => {
  const language = candidate("language", "Unknown", ["language:英语"]);
  const low = candidate("low", "Unknown", ["genre:neo-soul"]); low.featureVector.tags[0].confidence = .4;
  for (const item of [language, low]) {
    assert.equal(score(item).laneEvidence.match, false); assert.equal(score(item).laneEvidence.frontier, false);
  }
});
test("provider Electronica remains a broad exploration hint, not a strong acoustic match", () => {
  const known=candidate("electronic-known","A",["genre:electronica"]);
  const state=like(api.createEmptyListeningMemory(NOW),known);
  const item=candidate("electronic-new","B",["genre:electronica"]);
  assert.equal(score(item,"match",state).laneEvidence.match,false);
  assert.equal(score(item,"frontier",state).laneEvidence.frontier,true);
});
test("BPM alone is not a close-match or genre claim", () => {
  const known = candidate("tempo-known", "A"); known.featureVector.bpm = { value: 90, source: "audio_analysis", confidence: .8, profileEligible: true };
  const item = candidate("tempo-new", "B"); item.featureVector.bpm = { ...known.featureVector.bpm, value: 91 };
  const value = score(item, "match", like(api.createEmptyListeningMemory(NOW), known));
  assert.ok(value.contributions.find(part => part.key === "verified_track_similarity").signedWeight > 0);
  assert.equal(value.laneEvidence.match, false); assert.equal(value.laneEvidence.frontier, false);
});
test("one explicit artist does not qualify an entire discography with unknown song characteristics", () => {
  const known = candidate("rnb-known", "A", ["genre:r&b"]);
  const state = api.recordListeningEvent(like(api.createEmptyListeningMemory(NOW), known), { type: "preference_changed", eventId: "artist", targetType: "artist", targetKey: "A", value: "more", scope: "artist", createdAt: NOW, sessionId: memory.currentSession.sessionId });
  const sameDirection = candidate("rnb-new", "A", ["genre:r&b"]);
  const changedDirection = candidate("rock-new", "A", ["genre:rock"]);
  const unknownDirection = candidate("unknown-new", "A");
  assert.equal(score(sameDirection, "match", state).laneEvidence.match, false,
    "one work and one declaration do not establish a whole artist's broad-genre sound fit");
  for (const item of [changedDirection, unknownDirection]) {
    assert.equal(score(item, "match", state).laneEvidence.match, false);
    assert.equal(score(item, "frontier", state).laneEvidence.frontier, true);
  }
});
test("freshness and composition cannot push an ineligible high-score item through the gate", () => {
  const good = candidate("good", "A", ["genre:neo-soul"]);
  const bad = candidate("bad", "B", ["genre:techno"]);
  const scores = new Map([good, bad].map(item => [item.canonicalKey, score(item)])); scores.get(bad.canonicalKey).totalScore = 100;
  assert.deepEqual(api.composeRecommendations([bad, good], scores, "match", 12), [good]);
});
test("one composition enforces anchors and artist limits across the whole twelve", () => {
  const familiar = Array.from({ length: 5 }, (_, i) => candidate(`anchor-${i}`, "Known artist", ["genre:neo-soul"], { alreadyHeard: true, inLibrary: true }));
  const fresh = Array.from({ length: 20 }, (_, i) => candidate(`fresh-${i}`, `New artist ${i % 5}`, ["genre:neo-soul"]));
  const selected = compose([...familiar, ...fresh], "match");
  assert.equal(selected.length, 12); assert.equal(selected.filter(item => item.alreadyHeard).length, 2);
  assert.ok(selected.filter(item => !item.alreadyHeard).length >= 10);
  for (const artist of new Set(selected.map(item => item.track.artist))) assert.ok(selected.filter(item => item.track.artist === artist).length <= 3);
});
test("frontier independently rejects unrelated leftovers and close same-artist duplicates", () => {
  const known = candidate("rnb-known-2", "A", ["genre:r&b"]);
  const another = candidate("rnb-known-3", "A", ["genre:r&b"]);
  const state = api.recordListeningEvent(like(like(api.createEmptyListeningMemory(NOW), known), another), { type: "preference_changed", eventId: "artist-2", targetType: "artist", targetKey: "A", value: "more", scope: "artist", createdAt: NOW, sessionId: memory.currentSession.sessionId });
  const close = candidate("close-leftover", "A", ["genre:r&b"]);
  const bridge = candidate("credible-bridge", "B", ["genre:r&b"]);
  const unrelated = candidate("unrelated-leftover", "C", ["genre:techno"]);
  assert.deepEqual(compose([close, unrelated, bridge], "frontier", state), [bridge]);
});
test("broad artist-style admission needs independent works and loses support on withdrawal", () => {
  const first = candidate("known-work-one", "A", ["genre:pop"]);
  const second = candidate("known-work-two", "A", ["genre:pop"]);
  const unheard = candidate("new-work", "A", ["genre:pop"]);
  const one = like(api.createEmptyListeningMemory(NOW), first), two = like(one, second);
  assert.equal(score(unheard, "match", one).laneEvidence.match, false);
  assert.equal(score(unheard, "match", two).laneEvidence.match, true);
  assert.equal(unheard.alreadyHeard, false, "the new song need not have been heard");
  assert.equal(score(candidate("new-rock-work", "A", ["genre:rock"]), "match", two).laneEvidence.match, false);
  const preference = api.activePreferences(two, NOW).find(event => event.targetKey === second.canonicalKey);
  const withdrawn = api.recordListeningEvent(two, { ...preference, eventId: "withdraw-second-work", value: "neutral", supersedesEventId: preference.eventId, createdAt: NOW + 1 });
  assert.equal(score(unheard, "match", withdrawn).laneEvidence.match, false);
});
test("broad genre plus matching measured tempo does not establish a close sound match", () => {
  const known = candidate("bpm-pop-known", "A", ["genre:pop"]), unheard = candidate("bpm-pop-new", "B", ["genre:pop"]);
  known.featureVector.bpm = { value: 90, source: "audio_analysis", confidence: .9, profileEligible: true };
  unheard.featureVector.bpm = { ...known.featureVector.bpm, value: 91 };
  const value = score(unheard, "match", like(api.createEmptyListeningMemory(NOW), known));
  assert.equal(value.laneEvidence.match, false);
  assert.ok(value.contributions.find(item => item.key === "verified_track_similarity").signedWeight > 0, "valid tempo evidence is retained as a limited score contribution");
});
test("close explanations prioritize a real relationship rather than mere non-repetition", () => {
  const value = score(candidate("explanation", "B", ["genre:neo-soul"]));
  assert.notEqual(value.topReasons[0], "最近没有反复出现");
  assert.match(value.topReasons[0], /偏好|曲风/);
});
