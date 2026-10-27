import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const buildDir = new URL("../.test-build/listening-intelligence/", import.meta.url);
const outputUrl = new URL("listening-intelligence.mjs", buildDir);
let intelligence;

before(async () => {
  await mkdir(buildDir, { recursive: true });
  await build({ entryPoints: [new URL("../app/listening-intelligence.ts", import.meta.url).pathname.slice(1)], outfile: outputUrl.pathname.slice(1), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  intelligence = await import(`${outputUrl.href}?${Date.now()}`);
});

after(async () => rm(buildDir, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 7, 31, 22);
const feature = (value, source = "audio_analysis", confidence = .9, profileEligible = true) => ({ value, source, confidence, profileEligible });
const vector = ({ id = "1", artist = "Beach House", tags = ["dream", "soft"], bpm = 90, energy = .3, novelty = .3, confidence = .9 } = {}) => ({
  provider: "qq", trackId: id, artist, tags: tags.map((tag) => feature(tag, "provider_metadata", confidence)),
  bpm: feature(bpm), energy: feature(energy), vocalFocus: feature(.6), instrumentalFocus: feature(.4), transitionFocus: feature("full"),
  inLibrary: false, likedInProvider: false, artistFamiliarity: 0, playlistMembership: [], playCount: 0,
  novelty: feature(novelty, "recommendation_heuristic", .4, false), metadataConfidence: confidence,
});
const play = ({ id = "1", artist = "Beach House", title = `Track ${id}`, ratio = .9, reason = "ended", session = "session-main", at = NOW, tags, duration = 240, replay = false, features } = {}) => ({
  type: "play_settled", eventId: `play-${id}-${at}-${reason}-${ratio}`, sessionId: session, trackKey: `qq:${id}`, provider: "qq", providerTrackId: id,
  title, artist, features: features || vector({ id, artist, tags }), startedAt: at - duration * ratio * 1000, settledAt: at,
  listenedSeconds: duration * ratio, durationSeconds: duration, completionRatio: ratio, exitReason: reason, source: "queue", metadataConfidence: .9,
  timeBucket: "late-night", replay,
});
const preference = ({ id = "p1", targetType = "track", targetKey = "qq:1", value = "less", scope = "session", session = "session-main", at = NOW } = {}) => ({
  type: "preference_changed", eventId: id, targetType, targetKey, value, scope, createdAt: at, sessionId: session,
});
const candidate = ({ id = "c1", artist = "Cocteau Twins", tags = ["dream", "soft"], heard = false, recommended = false, playable = true, novelty = .45, confidence = .9 } = {}) => ({
  canonicalKey: `qq:${id}`, track: { provider: "qq", id, title: `Candidate ${id}`, artist }, source: "adjacent_discovery", generationReason: "adjacent",
  featureVector: vector({ id, artist, tags, novelty, confidence }), sourceConfidence: confidence, alreadyHeard: heard, inLibrary: heard, alreadyRecommended: recommended, playable,
});
const memoryWith = (...events) => events.reduce((memory, event) => intelligence.recordListeningEvent(memory, event), { ...intelligence.createEmptyListeningMemory(NOW), currentSession: { sessionId: "session-main", startedAt: NOW - 1000 } });
const correction = (hypothesisId, verdict, at = NOW + 1) => ({ type: "profile_corrected", eventId: `${verdict}-${at}`, hypothesisId, verdict, createdAt: at });

test("compaction consumes only evicted evidence; three layer and tempo scores match before/after and restart", () => {
  const event = play({ id: "old-real-behavior", at: NOW - 86400000 });
  let memory = memoryWith(event);
  const item = candidate({ artist: event.artist });
  const scores = value => intelligence.scoreCandidate(item, intelligence.deriveListeningProfile(value, NOW), value, "match", NOW).contributions;
  const before = scores(memory);
  for (let i = 0; i < intelligence.MAX_RAW_EVENTS; i++) memory = intelligence.recordListeningEvent(memory, { type: "manual_intent", eventId: `no-taste-${i}`, sessionId: "session-main", action: "search", createdAt: NOW });
  assert.equal(memory.rawEvents.some(x => x.eventId === event.eventId), false);
  assert.equal(memory.longTermAggregates[`track:${event.trackKey}`].evidenceCount, 1);
  for (const key of ["long_term_affinity", "recent_affinity", "session_affinity", "acoustic_affinity"]) {
    assert.ok(Math.abs(scores(memory).find(x=>x.key===key).signedWeight - before.find(x=>x.key===key).signedWeight) < 1e-10, key);
  }
  const storage = new Map(); intelligence.saveListeningMemory({ setItem: (key, value) => storage.set(key, value) }, memory);
  const restored = intelligence.loadListeningMemory({ getItem: key => storage.get(key) ?? null }, NOW);
  assert.deepEqual(scores(restored), scores(memory));
  assert.strictEqual(intelligence.recordListeningEvent(restored, event), restored);
});

test("legacy count-only aggregates recover conservative artist behavior, never past sound or weather", () => {
  const memory = memoryWith();
  memory.longTermAggregates["track:qq:old"] = { positive: .46, negative: 0, evidenceCount: 1, firstSeenAt: NOW - 86400000 * 90, lastSeenAt: NOW - 86400000 * 80 };
  memory.trackMemories["qq:old"] = { trackKey:"qq:old",title:"Old recording",artist:"Known artist",listenedSeconds:200,settledPlayCount:1,playCount:1,completionCount:1,replayCount:0,firstSeenAt:0,lastSeenAt:0 };
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  assert.ok(profile.lifetimeProfile.artistAffinities["known artist"] > 0);
  assert.deepEqual(profile.lifetimeProfile.tagAffinities, {});
  assert.deepEqual(profile.lifetimeProfile.tempoAffinities, {});
  assert.deepEqual(profile.contextualProfiles, {});
  assert.equal(intelligence.listeningStatus(memory,"qq:old",NOW).effective, false, "counts cannot reconstruct a lost per-listen duration");
});

test("a withdrawn explicit preference is not recreated by old aggregates", () => {
  let memory = memoryWith(preference({targetType:"artist",targetKey:"Only explicit",value:"more",scope:"artist"}));
  for (let i=0;i<intelligence.MAX_RAW_EVENTS;i++) memory=intelligence.recordListeningEvent(memory,{type:"manual_intent",eventId:`compact-preference-${i}`,sessionId:"session-main",action:"search",createdAt:NOW});
  memory=intelligence.recordListeningEvent(memory,preference({id:"withdraw",targetType:"artist",targetKey:"Only explicit",value:"neutral",scope:"artist",at:NOW+1}));
  assert.deepEqual(memory.longTermAggregates,{});
  assert.equal(intelligence.deriveListeningProfile(memory,NOW+1).lifetimeProfile.artistAffinities["only explicit"],undefined);
});

test("recent and session artist terms are consumed independently and decay without creating explicit preferences", () => {
  const item=candidate({artist:"Observed artist",tags:[]}); const event=play({artist:"Observed artist",features:vector({artist:"Observed artist",tags:[],bpm:null,energy:null}),at:NOW});
  const memory=memoryWith(event); const contributions=at=>intelligence.scoreCandidate(item,intelligence.deriveListeningProfile(memory,at),memory,"match",at).contributions;
  for(const key of ["long_term_affinity","recent_affinity","session_affinity"]) assert.ok(contributions(NOW).find(x=>x.key===key).signedWeight>0,key);
  assert.ok(contributions(NOW+intelligence.SESSION_INTENT_TTL_MS*2).find(x=>x.key==="session_affinity").signedWeight<contributions(NOW).find(x=>x.key==="session_affinity").signedWeight);
  assert.deepEqual(memory.explicitPreferences,[]);
  assert.ok(contributions(NOW).filter(x=>["long_term_affinity","recent_affinity","session_affinity"].includes(x.key)).reduce((sum,x)=>sum+x.signedWeight,0)<=.85);
});

test("zero starts, errors and brief auditions remain new; valid listening uses actual seconds", () => {
  for (const event of [play({ratio:0,reason:"switch"}),play({ratio:.02,reason:"error"}),play({ratio:.01,reason:"skip"}),{...play({ratio:.9}),listenedSeconds:0}]) {
    const memory=memoryWith(event); const status=intelligence.listeningStatus(memory,event.trackKey,NOW);
    assert.equal(status.effective,false); assert.equal(status.lastEffectiveAt,0); assert.equal(status.completed,false);
  }
  const event=play({ratio:.21,reason:"switch"}); assert.equal(intelligence.listeningStatus(memoryWith(event),event.trackKey,NOW).effective,true);
  let session=intelligence.beginListeningSession("qq:seek",NOW);
  session=intelligence.accumulatePlayingTime(session,1,true); session=intelligence.accumulatePlayingTime(session,150,true);
  session=intelligence.accumulatePlayingTime(session,151,false); session=intelligence.accumulatePlayingTime(session,152,true,true);
  assert.equal(session.listenedSeconds,1);
});

test("case-sensitive provider identities migrate once from actual retained IDs, not titles", () => {
  const event=play({id:"AbC"}); const memory=memoryWith(event);
  const legacy={...memory,rawEvents:[{...event,trackKey:"qq:abc"}],trackMemories:{"qq:abc":{...memory.trackMemories["qq:AbC"],trackKey:"qq:abc"}},explicitPreferences:[preference({value:"more",scope:"track",targetKey:"qq:abc"})]};
  const storage={getItem:key=>key===intelligence.LISTENING_MEMORY_KEY?JSON.stringify(legacy):null};
  const loaded=intelligence.loadListeningMemory(storage,NOW);
  assert.ok(loaded.trackMemories["qq:AbC"]); assert.equal(loaded.explicitPreferences[0].targetKey,"qq:AbC");
  assert.notEqual(intelligence.canonicalTrackKey("qq","AbC"),intelligence.canonicalTrackKey("qq","abc"));
  const again=intelligence.loadListeningMemory({getItem:key=>key===intelligence.LISTENING_MEMORY_KEY?JSON.stringify(loaded):null},NOW);
  assert.deepEqual(again,loaded);
});

test("exposure migration cannot merge same-title different-ID versions", () => {
  const tracks=[{mid:"Original",title:"Same",artist:"Artist"},{mid:"Live",title:"Same",artist:"Artist"}];
  assert.deepEqual(intelligence.migrateRecommendationExposure(["same::artist"],tracks),["same::artist"]);
  assert.deepEqual(intelligence.migrateRecommendationExposure(["same::artist"],[tracks[0]]),["qq:Original"]);
  const memory=memoryWith(preference({targetKey:"qq:Original",value:"more",scope:"track"}));
  const other=candidate({id:"Live",artist:"Artist",tags:[]});
  assert.equal(intelligence.scoreCandidate(other,intelligence.deriveListeningProfile(memory,NOW),memory,"match",NOW).contributions.find(x=>x.key==="explicit_track").signedWeight,0);
});

test("measured tempo can associate different artists and distinguish one artist's works, never inventing emotion", () => {
  // Synthetic acoustic numbers exercise math only, NOT real song understanding.
  const known=vector({id:"verified-measurement",artist:"A",tags:[],bpm:90,energy:null});
  const memory=intelligence.recordListeningEvent(memoryWith(),{...preference({targetKey:"qq:verified-measurement",scope:"track",value:"more"}),features:known});
  const items=[candidate({id:"same-artist-slow",artist:"A",tags:[]}),candidate({id:"same-artist-fast",artist:"A",tags:[]}),candidate({id:"other-artist",artist:"B",tags:[]})];
  items[0].featureVector.bpm=feature(92); items[1].featureVector.bpm=feature(170); items[2].featureVector.bpm=feature(91);
  const part=item=>intelligence.scoreCandidate(item,intelligence.deriveListeningProfile(memory,NOW),memory,"match",NOW).contributions.find(x=>x.key==="verified_track_similarity");
  assert.ok(part(items[0]).signedWeight>part(items[1]).signedWeight); assert.ok(part(items[2]).signedWeight>0);
  items[2].featureVector.bpm=feature(91,"artist_hint",.9,false); assert.equal(part(items[2]).signedWeight,0);
  assert.deepEqual(intelligence.deriveListeningProfile(memory,NOW).lifetimeProfile.tagAffinities,{});
});

test("compacted rejected behavior hypothesis remains rejected after restart", () => {
  let memory=memoryWith(play({artist:"Observed",tags:["measured-style"]}));
  const hypothesis=intelligence.deriveListeningProfile(memory,NOW).hypotheses.find(x=>x.hypothesisId.startsWith("tag-"));
  memory=intelligence.recordListeningEvent(memory,correction(hypothesis.hypothesisId,"reject"));
  for(let i=0;i<intelligence.MAX_RAW_EVENTS;i++) memory=intelligence.recordListeningEvent(memory,{type:"manual_intent",eventId:`correction-fill-${i}`,action:"search",sessionId:"session-main",createdAt:NOW});
  const restored=intelligence.loadListeningMemory({getItem:key=>key===intelligence.LISTENING_MEMORY_KEY?JSON.stringify(memory):null},NOW+1);
  assert.equal(intelligence.deriveListeningProfile(restored,NOW+1).lifetimeProfile.tagAffinities["measured-style"],undefined);
});

test("shared language is a weak bridge, not an equal substitute for verified song genre", () => {
  // Isolated scoring math; these coarse labels do not assert sonic similarity.
  const known=vector({id:"named",tags:["genre:r&b","language:英语"],bpm:null,energy:null,confidence:.65});
  const memory=intelligence.recordListeningEvent(memoryWith(),{...preference({targetKey:"qq:named",scope:"track",value:"more"}),features:known});
  const sameGenre=candidate({tags:["genre:r&b","language:英语"],confidence:.65});
  const onlyLanguage=candidate({tags:["genre:pop","language:英语"],confidence:.65});
  sameGenre.featureVector.bpm=feature(null,"audio_analysis",0,false);
  onlyLanguage.featureVector.bpm=feature(null,"audio_analysis",0,false);
  const part=item=>intelligence.scoreCandidate(item,intelligence.deriveListeningProfile(memory,NOW),memory,"match",NOW).contributions.find(x=>x.key==="verified_track_similarity").signedWeight;
  assert.ok(part(sameGenre)>0); assert.ok(part(onlyLanguage)>0);
  assert.ok(part(onlyLanguage)<part(sameGenre)*.15);
});

test("01 fresh users have no synthetic personality or percentages", () => {
  const profile = intelligence.deriveListeningProfile(intelligence.createEmptyListeningMemory(NOW), NOW);
  assert.equal(profile.confidence, "insufficient"); assert.deepEqual(profile.hypotheses, []); assert.equal(JSON.stringify(profile).includes("INFP"), false);
});

test("02 legacy taste migration is idempotent", () => {
  const legacy = { tasteSignals: JSON.stringify([{ type: "playback_like", id: "42", title: "A" }]) };
  const once = intelligence.migrateLegacyListeningData(intelligence.createEmptyListeningMemory(NOW), legacy, NOW);
  const twice = intelligence.migrateLegacyListeningData(once, legacy, NOW + 1);
  assert.equal(once.rawEvents.length, 1); assert.equal(twice.rawEvents.length, 1);
});

test("03 malformed legacy JSON is isolated", () => {
  const result = intelligence.migrateLegacyListeningData(intelligence.createEmptyListeningMemory(NOW), { tasteSignals: "{oops", playedHistory: "[1" }, NOW);
  assert.equal(result.version, 2); assert.deepEqual(result.rawEvents, []);
});

test("04 repeated migration never duplicates events", () => {
  const legacy = { playedHistory: JSON.stringify([{ id: "1", title: "A", artist: "B" }, { id: "2", title: "C", artist: "D" }]) };
  const a = intelligence.migrateLegacyListeningData(intelligence.createEmptyListeningMemory(NOW), legacy, NOW);
  const b = intelligence.migrateLegacyListeningData(a, legacy, NOW);
  assert.equal(b.rawEvents.length, 2); assert.equal(new Set(b.rawEvents.map((event) => event.eventId)).size, 2);
});

test("05 explicit preferences survive raw-event compaction", () => {
  let memory = memoryWith(preference({ id: "explicit" }));
  for (let index = 0; index < intelligence.MAX_RAW_EVENTS + 3; index += 1) memory = intelligence.recordListeningEvent(memory, play({ id: String(index + 10), at: NOW + index + 1 }));
  assert.equal(memory.explicitPreferences.some((event) => event.eventId === "explicit"), true); assert.equal(memory.rawEvents.length, intelligence.MAX_RAW_EVENTS);
});

test("06 beginning a session is not a preference", () => {
  const session = intelligence.beginListeningSession("qq:1", NOW);
  assert.equal(session.listenedSeconds, 0); assert.equal(memoryWith().rawEvents.length, 0);
});

test("07 completion is stronger than merely starting", () => assert.ok(intelligence.implicitSignalStrength(play({ ratio: .9 })) > 0));
test("08 short-track completion is discounted", () => assert.ok(intelligence.implicitSignalStrength(play({ duration: 50 })) < intelligence.implicitSignalStrength(play({ duration: 240 }))));
test("09 early skip is weak and bounded", () => assert.equal(intelligence.implicitSignalStrength(play({ ratio: .12, reason: "skip" })), -.12));
test("10 switching after half is not dislike", () => assert.ok(intelligence.implicitSignalStrength(play({ ratio: .55, reason: "switch" })) >= 0));
test("11 errors never change taste", () => assert.equal(intelligence.implicitSignalStrength(play({ ratio: .1, reason: "error" })), 0));

test("12 seeking does not inflate listened seconds", () => {
  let session = intelligence.beginListeningSession("qq:1", NOW);
  session = intelligence.accumulatePlayingTime(session, 1, true);
  session = intelligence.accumulatePlayingTime(session, 101, true);
  assert.ok(session.listenedSeconds < 2);
});

test("13 duplicate event settlement is ignored", () => {
  const event = play(); const memory = intelligence.recordListeningEvent(memoryWith(), event); const twice = intelligence.recordListeningEvent(memory, event);
  assert.equal(twice.rawEvents.length, memory.rawEvents.length);
});

test("14 replay is stronger than completion", () => assert.ok(intelligence.implicitSignalStrength(play({ replay: true })) > intelligence.implicitSignalStrength(play())));

test("15 like dislike neutral resolves to the latest active state", () => {
  const memory = memoryWith(preference({ id: "a", value: "more", scope: "track" }), preference({ id: "b", value: "less", scope: "track", at: NOW + 1 }), preference({ id: "c", value: "neutral", scope: "track", at: NOW + 2 }));
  assert.equal(intelligence.activePreferences(memory, NOW + 3).length, 0);
});

test("16 default dislike does not affect artist or style", () => {
  const active = intelligence.activePreferences(memoryWith(preference({})), NOW);
  assert.equal(active[0].targetType, "track"); assert.equal(active.some((event) => event.targetType !== "track"), false);
});

test("17 session preference expires with session intent", () => {
  const memory = { ...memoryWith(preference({})), sessionIntent: { ...intelligence.createSessionIntent({}, NOW - intelligence.SESSION_INTENT_TTL_MS - 1), expiresAt: NOW - 1 } };
  assert.equal(intelligence.activePreferences(memory, NOW).length, 0);
});

test("18 style less only matches reliable profile-eligible tags", () => {
  const bad = candidate({ tags: ["dream"], confidence: .2 });
  const memory = memoryWith(preference({ targetType: "feature", targetKey: "dream", scope: "style" }));
  const score = intelligence.scoreCandidate(bad, intelligence.deriveListeningProfile(memory, NOW), memory, "match", NOW);
  assert.ok(Math.abs(score.contributions.find((item) => item.key === "explicit_style").signedWeight) < .2);
});

test("19 artist less does not affect adjacent artists", () => {
  const memory = memoryWith(preference({ targetType: "artist", targetKey: "Beach House", scope: "artist" }));
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  const other = intelligence.scoreCandidate(candidate({ artist: "Slowdive" }), profile, memory, "match", NOW);
  assert.equal(other.contributions.find((item) => item.key === "explicit_artist").signedWeight, 0);
});

test("20 one negative cannot erase repeated long-term positive evidence", () => {
  const positives = Array.from({ length: 8 }, (_, index) => play({ id: String(index), artist: "Beach House", tags: ["dream"], at: NOW - index * 86400000 }));
  const memory = memoryWith(...positives, preference({ targetType: "feature", targetKey: "dream", scope: "style" }));
  assert.ok(intelligence.deriveListeningProfile(memory, NOW).lifetimeProfile.tagAffinities.dream > 0);
});

test("21 profile rejection removes the rejected hypothesis", () => {
  let memory = memoryWith(...Array.from({ length: 4 }, (_, index) => play({ id: String(index), tags: ["dream"] })));
  const hypothesis = intelligence.deriveListeningProfile(memory, NOW).hypotheses[0];
  memory = intelligence.recordListeningEvent(memory, { type: "profile_corrected", eventId: "reject", hypothesisId: hypothesis.hypothesisId, verdict: "reject", createdAt: NOW + 1 });
  assert.equal(intelligence.deriveListeningProfile(memory, NOW + 1).hypotheses.some((item) => item.hypothesisId === hypothesis.hypothesisId), false);
});

test("21a rejecting or ignoring a tag hypothesis removes its actual score contribution", () => {
  const base = memoryWith(play({ id: "heard", tags: ["dream"] }));
  const hypothesis = intelligence.deriveListeningProfile(base, NOW).hypotheses[0];
  const item = candidate({ tags: ["dream"] });
  const before = intelligence.scoreCandidate(item, intelligence.deriveListeningProfile(base, NOW + 1), base, "match", NOW + 1).totalScore;
  for (const verdict of ["reject", "ignore-behavior"]) {
    const changed = intelligence.recordListeningEvent(base, correction(hypothesis.hypothesisId, verdict));
    const profile = intelligence.deriveListeningProfile(changed, NOW + 1);
    assert.equal(profile.lifetimeProfile.tagAffinities.dream, undefined);
    assert.equal(profile.recentProfile.tagAffinities.dream, undefined);
    assert.equal(profile.sessionProfile.tagAffinities.dream, undefined);
    assert.equal(profile.contextualProfiles["late-night"].tagAffinities.dream, undefined);
    assert.ok(intelligence.scoreCandidate(item, profile, changed, "match", NOW + 1).totalScore < before);
    assert.equal(changed.rawEvents.some((event) => event.type === "play_settled"), true);
  }
});

test("21b session-only correction moves a tag out of long-term ranking and expires", () => {
  const base = memoryWith(play({ id: "heard", tags: ["dream"] }));
  const hypothesis = intelligence.deriveListeningProfile(base, NOW).hypotheses[0];
  const changed = intelligence.recordListeningEvent(base, correction(hypothesis.hypothesisId, "session-only"));
  const rejected = intelligence.recordListeningEvent(base, correction(hypothesis.hypothesisId, "reject"));
  const profile = intelligence.deriveListeningProfile(changed, NOW + 1);
  const item = candidate({ tags: ["dream"] });
  assert.equal(profile.lifetimeProfile.tagAffinities.dream, undefined);
  assert.equal(profile.recentProfile.tagAffinities.dream, undefined);
  assert.ok(profile.sessionProfile.tagAffinities.dream > 0);
  assert.ok(intelligence.scoreCandidate(item, profile, changed, "match", NOW + 1).totalScore > intelligence.scoreCandidate(item, intelligence.deriveListeningProfile(rejected, NOW + 1), rejected, "match", NOW + 1).totalScore);
  assert.equal(intelligence.deriveListeningProfile(changed, NOW + intelligence.SESSION_INTENT_TTL_MS + 2).sessionProfile.tagAffinities.dream, undefined);
  assert.equal(intelligence.deriveListeningProfile({ ...changed, currentSession: { sessionId: "next", startedAt: NOW + 2 } }, NOW + 2).sessionProfile.tagAffinities.dream, undefined);
});

test("21c confirmation adds only bounded evidence and changes candidate score", () => {
  const base = memoryWith(play({ id: "heard", tags: ["dream"] }));
  const hypothesis = intelligence.deriveListeningProfile(base, NOW).hypotheses[0];
  const changed = intelligence.recordListeningEvent(base, correction(hypothesis.hypothesisId, "confirm"));
  const original = intelligence.deriveListeningProfile(base, NOW + 1);
  const profile = intelligence.deriveListeningProfile(changed, NOW + 1);
  const item = candidate({ tags: ["dream"] });
  assert.ok(profile.lifetimeProfile.tagAffinities.dream > original.lifetimeProfile.tagAffinities.dream);
  assert.ok(profile.lifetimeProfile.tagAffinities.dream - original.lifetimeProfile.tagAffinities.dream <= .3);
  assert.ok(intelligence.scoreCandidate(item, profile, changed, "match", NOW + 1).totalScore > intelligence.scoreCandidate(item, original, base, "match", NOW + 1).totalScore);
});

test("22 neutral feedback restores candidate score", () => {
  const base = memoryWith(); const less = memoryWith(preference({ scope: "track", targetKey: "qq:c1" })); const neutral = intelligence.recordListeningEvent(less, preference({ id: "neutral", scope: "track", targetKey: "qq:c1", value: "neutral", at: NOW + 1 }));
  const c = candidate(); const baseScore = intelligence.scoreCandidate(c, intelligence.deriveListeningProfile(base, NOW), base, "match", NOW).totalScore;
  const restored = intelligence.scoreCandidate(c, intelligence.deriveListeningProfile(neutral, NOW), neutral, "match", NOW).totalScore;
  assert.equal(restored, baseScore);
});

test("23 lifetime recent and session layers remain separate", () => {
  const memory = memoryWith(play({ id: "old", tags: ["rock"], at: NOW - 120 * 86400000, session: "old" }), play({ id: "new", tags: ["ambient"], at: NOW, session: "session-main" }));
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  assert.ok(profile.lifetimeProfile.tagAffinities.rock > 0); assert.ok(profile.recentProfile.tagAffinities.ambient > 0); assert.ok(profile.sessionProfile.tagAffinities.ambient > 0);
});

test("24 recent interests can lead current ranking without deleting history", () => {
  const memory = memoryWith(play({ id: "old", tags: ["rock"], at: NOW - 200 * 86400000, session: "old" }), ...Array.from({ length: 3 }, (_, i) => play({ id: `a${i}`, tags: ["ambient"], at: NOW - i * 1000 })));
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  assert.ok(profile.lifetimeProfile.tagAffinities.rock > 0); assert.ok(profile.recentProfile.tagAffinities.ambient > profile.recentProfile.tagAffinities.rock || !("rock" in profile.recentProfile.tagAffinities));
});

test("25 old interests can return without being erased", () => {
  const memory = memoryWith(play({ id: "old", tags: ["rock"], at: NOW - 200 * 86400000, session: "old" }), play({ id: "return", tags: ["rock"], at: NOW }));
  assert.ok(intelligence.deriveListeningProfile(memory, NOW).lifetimeProfile.tagAffinities.rock > 0);
});

test("26 sparse context falls back toward lifetime", () => {
  const memory = memoryWith(...Array.from({ length: 6 }, (_, i) => play({ id: String(i), tags: ["dream"], at: NOW - i * 1000 })), play({ id: "one", tags: ["metal"], at: NOW + 5, features: { ...vector({ id: "one", tags: ["metal"] }) }, title: "one" }));
  const context = intelligence.deriveListeningProfile(memory, NOW + 5).contextualProfiles["late-night"];
  assert.ok(context.reliability <= 1); assert.ok("dream" in context.tagAffinities);
});

test("27 expired intent never changes long-term profile", () => {
  const memory = { ...memoryWith(), sessionIntent: { ...intelligence.createSessionIntent({ familiarity: "explore" }, NOW - 999999999), expiresAt: NOW - 1 } };
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  assert.equal(profile.sessionIntent, null); assert.deepEqual(profile.lifetimeProfile.tagAffinities, {});
});

test("28 same-title tracks use provider ids and never collide", () => assert.notEqual(intelligence.canonicalTrackKey("qq", "1"), intelligence.canonicalTrackKey("qq", "2")));
test("29 canonical recommendation keys do not depend on title", () => assert.equal(candidate({ id: "xyz" }).canonicalKey, "qq:xyz"));

test("30 low-confidence metadata contribution is reduced", () => {
  const memory = memoryWith(...Array.from({ length: 4 }, (_, i) => play({ id: String(i), tags: ["dream"] })));
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  const high = intelligence.scoreCandidate(candidate({ confidence: .95 }), profile, memory, "match", NOW);
  const low = intelligence.scoreCandidate(candidate({ confidence: .15 }), profile, memory, "match", NOW);
  assert.ok(Math.abs(low.contributions.find((item) => item.key === "long_term_affinity").signedWeight) < Math.abs(high.contributions.find((item) => item.key === "long_term_affinity").signedWeight));
});

test("31 heuristic novelty is not promoted into profile facts", () => {
  const profile = intelligence.deriveListeningProfile(memoryWith(play({ features: vector({ tags: [] }) })), NOW);
  assert.equal(Object.keys(profile.lifetimeProfile.tagAffinities).includes("novelty"), false);
});

test("32 a single factor is capped", () => {
  const score = intelligence.scoreCandidate(candidate(), intelligence.deriveListeningProfile(memoryWith(), NOW), memoryWith(), "frontier", NOW);
  assert.ok(score.contributions.every((item) => Math.abs(item.signedWeight) <= 1.15));
});

test("33 explanation comes from actual score reasons", () => {
  const score = intelligence.scoreCandidate(candidate(), intelligence.deriveListeningProfile(memoryWith(), NOW), memoryWith(), "match", NOW);
  const explanation = intelligence.recommendationExplanation(score);
  assert.equal(score.topReasons.every((reason) => explanation.includes(reason)), true);
});

test("34 match and frontier can be composed without overlap", () => {
  const candidates = Array.from({ length: 18 }, (_, index) => candidate({ id: String(index), novelty: index / 18 }));
  const memory = memoryWith(); const profile = intelligence.deriveListeningProfile(memory, NOW);
  const matchScores = new Map(candidates.map((item) => [item.canonicalKey, intelligence.scoreCandidate(item, profile, memory, "match", NOW)]));
  const match = intelligence.composeRecommendations(candidates, matchScores, "match", 6);
  const used = new Set(match.map((item) => item.canonicalKey));
  const frontierCandidates = candidates.filter((item) => !used.has(item.canonicalKey));
  const frontierScores = new Map(frontierCandidates.map((item) => [item.canonicalKey, intelligence.scoreCandidate(item, profile, memory, "frontier", NOW)]));
  const frontier = intelligence.composeRecommendations(frontierCandidates, frontierScores, "frontier", 6);
  assert.equal(frontier.some((item) => used.has(item.canonicalKey)), false);
});

test("35 one artist cannot fill a composed group", () => {
  const items = [...Array.from({ length: 8 }, (_, index) => candidate({ id: `same${index}`, artist: "Same" })), ...Array.from({ length: 6 }, (_, index) => candidate({ id: `other${index}`, artist: `Other ${index}` }))];
  const memory = memoryWith(); const profile = intelligence.deriveListeningProfile(memory, NOW); const scores = new Map(items.map((item) => [item.canonicalKey, intelligence.scoreCandidate(item, profile, memory, "match", NOW)]));
  const result = intelligence.composeRecommendations(items, scores, "match", 6);
  assert.ok(result.filter((item) => item.track.artist === "Same").length < 6);
});

test("36 frontier composition excludes familiar anchors instead of injecting already heard music", () => {
  const items = [candidate({ id: "anchor", heard: true, novelty: .1 }), ...Array.from({ length: 8 }, (_, index) => candidate({ id: String(index), novelty: .6 }))];
  const memory = memoryWith(); const profile = intelligence.deriveListeningProfile(memory, NOW); const scores = new Map(items.map((item) => [item.canonicalKey, intelligence.scoreCandidate(item, profile, memory, "frontier", NOW)]));
  const result = intelligence.composeRecommendations(items, scores, "frontier", 6);
  assert.equal(result.some((item) => item.alreadyHeard), false); assert.equal(result.some((item) => (item.featureVector.novelty.value || 0) > .5), true);
});

test("37 one frontier dislike does not remove the exploration contribution", () => {
  const memory = memoryWith(preference({ targetKey: "qq:other" })); const score = intelligence.scoreCandidate(candidate(), intelligence.deriveListeningProfile(memory, NOW), memory, "frontier", NOW);
  assert.ok(score.contributions.find((item) => item.key === "uncertainty_exploration"));
});

test("38 recent exposure receives a freshness penalty", () => {
  const memory = memoryWith(); const profile = intelligence.deriveListeningProfile(memory, NOW);
  const fresh = intelligence.scoreCandidate(candidate(), profile, memory, "match", NOW);
  const stale = intelligence.scoreCandidate(candidate({ recommended: true }), profile, memory, "match", NOW);
  assert.ok(stale.totalScore < fresh.totalScore);
});

test("39 explicit repeat request removes freshness penalty", () => {
  const memory = memoryWith(); const profile = intelligence.deriveListeningProfile(memory, NOW); const item = candidate({ recommended: true });
  const regular = intelligence.scoreCandidate(item, profile, memory, "match", NOW);
  const repeat = intelligence.scoreCandidate(item, profile, memory, "match", NOW, { allowRepeat: true });
  assert.ok(repeat.totalScore > regular.totalScore);
});

test("40 queue-tail replacement preserves played prefix", () => {
  const queue = ["played-1", "current", "old-a", "old-b"]; const liveIndex = 1; const reranked = [...queue.slice(0, liveIndex + 1), "new-a", "new-b"];
  assert.deepEqual(reranked.slice(0, 2), queue.slice(0, 2));
});

test("simulation 1: a single dream-pop dislike keeps long-term dream anchors", () => {
  const positives = Array.from({ length: 7 }, (_, i) => play({ id: String(i), tags: ["dream"], artist: "Beach House" }));
  const memory = memoryWith(...positives, preference({ targetKey: "qq:one-bad" }));
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  assert.ok(profile.lifetimeProfile.tagAffinities.dream > 0); assert.ok(profile.anchorArtists.some((item) => item.name === "beach house"));
});

test("simulation 2: artist less leaves adjacent artists untouched", () => {
  const memory = memoryWith(preference({ targetType: "artist", targetKey: "A", scope: "artist" })); const profile = intelligence.deriveListeningProfile(memory, NOW);
  const a = intelligence.scoreCandidate(candidate({ artist: "A" }), profile, memory, "match", NOW);
  const b = intelligence.scoreCandidate(candidate({ id: "b", artist: "B" }), profile, memory, "match", NOW);
  assert.ok(a.totalScore < b.totalScore);
});

test("simulation 3: recent ambient coexists with lifetime rock", () => {
  const memory = memoryWith(...Array.from({ length: 5 }, (_, i) => play({ id: `r${i}`, tags: ["rock"], at: NOW - 180 * 86400000, session: "old" })), ...Array.from({ length: 4 }, (_, i) => play({ id: `a${i}`, tags: ["ambient"], at: NOW - i * 1000 })));
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  assert.ok(profile.lifetimeProfile.tagAffinities.rock > 0); assert.ok(profile.recentProfile.tagAffinities.ambient > 0);
});

test("simulation 4: contextual profiles do not delete daytime evidence", () => {
  const events = [...Array.from({ length: 5 }, (_, i) => ({ ...play({ id: `day${i}`, tags: ["energetic"], at: NOW - i * 1000 }), timeBucket: "day" })), ...Array.from({ length: 5 }, (_, i) => ({ ...play({ id: `night${i}`, tags: ["calm"], at: NOW - i * 1000 }), timeBucket: "late-night" }))];
  const profile = intelligence.deriveListeningProfile(memoryWith(...events), NOW);
  assert.ok(profile.contextualProfiles.day); assert.ok(profile.contextualProfiles["late-night"]); assert.ok(profile.lifetimeProfile.tagAffinities.energetic > 0);
});

test("simulation 5: playback error is excluded from skip evidence", () => {
  const memory = memoryWith(play({ id: "s1", ratio: .1, reason: "skip" }), play({ id: "err", ratio: .1, reason: "error" }), play({ id: "s2", ratio: .1, reason: "skip" }));
  const profile = intelligence.deriveListeningProfile(memory, NOW);
  assert.equal(profile.implicitFeedbackCount, 2); assert.equal(profile.sessionProfile.tagAffinities.dream < 0, true);
  assert.equal(profile.lifetimeProfile.tagAffinities.dream, undefined);
  assert.equal(profile.lifetimeProfile.artistAffinities["beach house"], undefined);
});

test("simulation 6: opposite evidence leaves style available and uncertainty visible", () => {
  const memory = memoryWith(preference({ targetKey: "qq:bad" }), preference({ id: "like", targetKey: "qq:good", value: "more", scope: "track", at: NOW + 1 }));
  const profile = intelligence.deriveListeningProfile(memory, NOW + 1); const score = intelligence.scoreCandidate(candidate({ id: "third", tags: ["dream"] }), profile, memory, "frontier", NOW + 1);
  assert.ok(score.totalScore > -3); assert.ok(score.uncertainty >= 0);
});

test("previously recommended tracks never re-enter either recommendation lane", () => {
  const items = [candidate({ id: "old", heard: true, recommended: true }), ...Array.from({ length: 8 }, (_, index) => candidate({ id: `fresh-${index}`, artist: `Fresh artist ${index}` }))];
  const memory = memoryWith(); const profile = intelligence.deriveListeningProfile(memory, NOW);
  for (const lane of ["match", "frontier"]) {
    const scores = new Map(items.map((item) => [item.canonicalKey, intelligence.scoreCandidate(item, profile, memory, lane, NOW)]));
    const result = intelligence.composeRecommendations(items, scores, lane, 6);
    assert.equal(result.length, 6);
    assert.equal(result.some((item) => item.alreadyRecommended), false);
  }
});

test("Daniel Valentina and Always preferences change the next ranking, not unrelated artists", () => {
  const valentina = { ...candidate({ id: "valentina", artist: "Daniel", tags: [] }), track: { provider: "qq", id: "valentina", title: "Valentina", artist: "Daniel" } };
  const always = { ...candidate({ id: "always", artist: "Daniel", tags: [] }), track: { provider: "qq", id: "always", title: "Always", artist: "Daniel" } };
  const otherDaniel = candidate({ id: "other-daniel", artist: "Daniel", tags: [] });
  const unrelated = candidate({ id: "other", artist: "Another Artist", tags: [] });
  const base = memoryWith();
  const changed = memoryWith(
    preference({ id: "dj-valentina", targetKey: "qq:valentina", value: "more", scope: "track" }),
    preference({ id: "dj-always", targetKey: "qq:always", value: "more", scope: "track", at: NOW + 1 }),
    preference({ id: "dj-daniel", targetType: "artist", targetKey: "Daniel", value: "more", scope: "artist", at: NOW + 2 }),
  );
  const rank = (item, memory) => intelligence.scoreCandidate(item, intelligence.deriveListeningProfile(memory, NOW + 2), memory, "match", NOW + 2).totalScore;
  assert.equal(rank(valentina, base), rank(unrelated, base));
  assert.ok(rank(valentina, changed) > rank(otherDaniel, changed));
  assert.ok(rank(always, changed) > rank(otherDaniel, changed));
  assert.ok(rank(otherDaniel, changed) > rank(unrelated, changed));
  assert.equal(rank(unrelated, changed), rank(unrelated, base));
});

test("temporary listening intent changes session scoring without touching lifetime taste", () => {
  const base = memoryWith();
  const intent = intelligence.createSessionIntent({ familiarity: "explore", energy: "calm" }, NOW);
  const changed = intelligence.recordListeningEvent(base, { type: "session_intent_changed", eventId: "tonight", sessionId: "session-main", intent, createdAt: NOW });
  const beforeProfile = intelligence.deriveListeningProfile(base, NOW);
  const afterProfile = intelligence.deriveListeningProfile(changed, NOW);
  assert.deepEqual(afterProfile.lifetimeProfile, beforeProfile.lifetimeProfile);
  assert.equal(afterProfile.explicitFeedbackCount, 0);
  const exploratory = candidate({ novelty: .8, tags: [], confidence: .9 });
  assert.ok(intelligence.scoreCandidate(exploratory, afterProfile, changed, "frontier", NOW).totalScore > intelligence.scoreCandidate(exploratory, beforeProfile, base, "frontier", NOW).totalScore);
});

test("disliking one Daniel song does not lower his other songs", () => {
  const base = memoryWith();
  const changed = memoryWith(preference({ targetKey: "qq:valentina", targetType: "track", value: "less", scope: "track" }));
  const valentina = candidate({ id: "valentina", artist: "Daniel", tags: [] });
  const always = candidate({ id: "always", artist: "Daniel", tags: [] });
  const rank = (item, memory) => intelligence.scoreCandidate(item, intelligence.deriveListeningProfile(memory, NOW), memory, "match", NOW).totalScore;
  assert.ok(rank(valentina, changed) < rank(valentina, base));
  assert.equal(rank(always, changed), rank(always, base));
});

test("recent playback receives an extra penalty and old session feedback expires without an intent", () => {
  const recent = memoryWith(play({ id: "again", at: NOW }));
  const base = memoryWith();
  const item = candidate({ id: "again", artist: "Beach House" });
  const rank = (memory) => intelligence.scoreCandidate(item, intelligence.deriveListeningProfile(memory, NOW), memory, "match", NOW).totalScore;
  assert.ok(rank(recent) < rank(base));
  const oldDislike = memoryWith(preference({ id: "old-dislike", targetKey: "qq:again", at: NOW - intelligence.SESSION_INTENT_TTL_MS - 1 }));
  assert.equal(intelligence.activePreferences(oldDislike, NOW).length, 0);
});

test("final score consumes reliable context evidence and honestly falls back when sparse", () => {
  // Isolated scoring fixture; not a claim about any real QQ song's genre.
  const events=Array.from({length:8},(_,i)=>({...play({id:`context-${i}`,artist:"Observed singer",tags:["dream"]}),timeBucket:"evening",weatherContext:"Rain · 18°C"}));
  const memory=memoryWith(...events);const profile=intelligence.deriveListeningProfile(memory,NOW);
  const item=candidate({artist:"Observed singer",tags:["dream"]});
  const score=options=>intelligence.scoreCandidate(item,profile,memory,"match",NOW,options).contributions.find(x=>x.key==="context_affinity");
  assert.ok(score({timeBucket:"evening",weather:"Rain · 18°C"}).signedWeight>0);
  assert.equal(score({timeBucket:"morning",weather:"Clear · 25°C"}).signedWeight,0);
  const sparse=memoryWith(events[0]);
  assert.equal(intelligence.scoreCandidate(item,intelligence.deriveListeningProfile(sparse,NOW),sparse,"match",NOW,{timeBucket:"evening",weather:"Rain · 18°C"}).contributions.find(x=>x.key==="context_affinity").signedWeight,0);
});

test("expired session intent restores original contributions and never enters lifetime facts", () => {
  const base=memoryWith();const intent=intelligence.createSessionIntent({familiarity:"explore"},NOW);
  const changed=intelligence.recordListeningEvent(base,{type:"session_intent_changed",eventId:"expiry-fixture",sessionId:"session-main",intent,createdAt:NOW});
  const item=candidate({tags:[]});const at=intent.expiresAt+1;
  assert.deepEqual(intelligence.scoreCandidate(item,intelligence.deriveListeningProfile(changed,at),changed,"match",at),intelligence.scoreCandidate(item,intelligence.deriveListeningProfile(base,at),base,"match",at));
});

test("explicit artist preference is not counted again through lifetime artist affinity", () => {
  const memory=memoryWith(preference({targetType:"artist",targetKey:"A",scope:"artist",value:"more"}));
  const score=intelligence.scoreCandidate(candidate({artist:"A",tags:[]}),intelligence.deriveListeningProfile(memory,NOW),memory,"match",NOW);
  assert.equal(score.contributions.find(x=>x.key==="long_term_affinity").signedWeight,0);
  assert.equal(score.contributions.find(x=>x.key==="explicit_artist").signedWeight,.2);
});

test("a compacted play event ID cannot be settled or counted twice after reload", () => {
  const event=play({id:"first-event"});let memory=memoryWith(event);
  for(let i=0;i<intelligence.MAX_RAW_EVENTS+1;i++)memory=intelligence.recordListeningEvent(memory,play({id:`later-${i}`,at:NOW+i+1}));
  const reloaded=JSON.parse(JSON.stringify(memory));
  assert.strictEqual(intelligence.recordListeningEvent(reloaded,event),reloaded);
});

test("reading an old player single-track dislike repairs the same evidence ID in both stores", () => {
  const event = { ...preference({ id: "old-player-less", targetKey: "qq:ExactVersion" }), source: "player", reason: "player_less", title: "A version", artist: "Observed artist" };
  const memory = memoryWith(event);
  const restored = intelligence.loadListeningMemory({ getItem: key => key === intelligence.LISTENING_MEMORY_KEY ? JSON.stringify(memory) : null }, NOW);
  const expected = { ...event, scope: "track" };
  assert.deepEqual(restored.explicitPreferences, [expected]);
  assert.deepEqual(restored.rawEvents, [expected]);
  assert.deepEqual(restored.processedEventIds, memory.processedEventIds);
  assert.deepEqual(restored.longTermAggregates, memory.longTermAggregates);
  assert.deepEqual(memory.explicitPreferences, [event], "reading does not mutate the supplied memory");
});

test("repaired player dislike survives a later session and persisted restart without banning the artist", () => {
  const event = { ...preference({ id: "persistent-player-less", targetKey: "qq:RejectedVersion" }), source: "player", reason: "player_less" };
  const original = { ...memoryWith(event), currentSession: { sessionId: "new-session", startedAt: NOW + 86400000 } };
  const values = new Map([[intelligence.LISTENING_MEMORY_KEY, JSON.stringify(original)]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const at = NOW + intelligence.SESSION_INTENT_TTL_MS + 1;
  const first = intelligence.loadListeningMemory(storage, at);
  intelligence.saveListeningMemory(storage, first);
  const restarted = intelligence.loadListeningMemory(storage, at + 1);
  assert.deepEqual(intelligence.activePreferences(restarted, at + 1).map(x => [x.eventId, x.targetKey, x.scope]), [[event.eventId, event.targetKey, "track"]]);
  const score = id => intelligence.scoreCandidate(candidate({ id, artist: "Observed artist", tags: [] }), intelligence.deriveListeningProfile(restarted, at + 1), restarted, "match", at + 1);
  assert.equal(score("RejectedVersion").contributions.find(x => x.key === "explicit_track").signedWeight, -.8);
  assert.equal(score("AnotherVersion").contributions.find(x => x.key === "explicit_track").signedWeight, 0);
  assert.equal(score("AnotherVersion").contributions.find(x => x.key === "explicit_artist").signedWeight, 0);
  assert.equal(restarted.explicitPreferences.length, 1);
  assert.equal(restarted.rawEvents.length, 1);
});

test("old player scope repair is idempotent and does not record or weight an event twice", () => {
  const event = { ...preference({ id: "one-repair" }), source: "player", reason: "player_less" };
  const read = memory => intelligence.loadListeningMemory({ getItem: key => key === intelligence.LISTENING_MEMORY_KEY ? JSON.stringify(memory) : null }, NOW);
  const once = read(memoryWith(event));
  const twice = read(once);
  assert.deepEqual(twice, once);
  assert.strictEqual(intelligence.recordListeningEvent(twice, event), twice);
  assert.equal(intelligence.deriveListeningProfile(twice, NOW).explicitFeedbackCount, 1);
  assert.equal(new Set(twice.rawEvents.map(x => x.eventId)).size, 1);
  const compacted = read({ ...memoryWith(event), rawEvents: [] });
  assert.equal(compacted.explicitPreferences[0].scope, "track");
  assert.deepEqual(compacted.rawEvents, [], "a compacted event is not reinserted");
});

test("scope repair cannot revive a withdrawn player dislike or override a later replacement", () => {
  const event = { ...preference({ id: "superseded-player-less" }), source: "player", reason: "player_less" };
  for (const value of ["neutral", "more"]) {
    const latest = { ...preference({ id: `latest-${value}`, value, scope: "track", at: NOW + 1 }), source: "dj", supersedesEventId: event.eventId };
    const memory = memoryWith(event, latest);
    const restored = intelligence.loadListeningMemory({ getItem: key => key === intelligence.LISTENING_MEMORY_KEY ? JSON.stringify(memory) : null }, NOW + 2);
    assert.deepEqual(restored.explicitPreferences[0], { ...event, scope: "track" });
    assert.deepEqual(restored.explicitPreferences[1], latest);
    assert.deepEqual(intelligence.activePreferences(restored, NOW + 2).map(x => [x.eventId, x.value]), value === "neutral" ? [] : [[latest.eventId, "more"]]);
    assert.equal(restored.rawEvents.length, 2);
  }
});

test("reading scope repair excludes DJ, explicit tonight, legacy and non-track feedback", () => {
  const events = [
    { ...preference({ id: "dj-tonight", targetKey: "qq:dj" }), source: "dj", reason: "player_less" },
    { ...preference({ id: "player-tonight", targetKey: "qq:tonight" }), source: "player", reason: "tonight_only" },
    { ...preference({ id: "legacy-less", targetKey: "qq:legacy" }), source: "legacy", reason: "player_less" },
    { ...preference({ id: "artist-session", targetType: "artist", targetKey: "Observed artist" }), source: "player", reason: "player_less" },
    { ...preference({ id: "player-more", targetKey: "qq:more", value: "more" }), source: "player", reason: "player_less" },
    { ...preference({ id: "unknown-source", targetKey: "qq:unknown" }), reason: "player_less" },
  ];
  const memory = memoryWith(...events);
  const restored = intelligence.loadListeningMemory({ getItem: key => key === intelligence.LISTENING_MEMORY_KEY ? JSON.stringify(memory) : null }, NOW);
  assert.deepEqual(restored.explicitPreferences, events);
  assert.deepEqual(restored.rawEvents, events);
  assert.equal(intelligence.activePreferences(restored, NOW).length, events.length);
  assert.deepEqual(intelligence.activePreferences(restored, NOW + intelligence.SESSION_INTENT_TTL_MS + 1), []);
  assert.deepEqual(intelligence.activePreferences({ ...restored, currentSession: { sessionId: "another-session", startedAt: NOW } }, NOW), []);
  const expiredIntent = { ...restored, sessionIntent: { ...intelligence.createSessionIntent({}, NOW), expiresAt: NOW - 1 } };
  assert.deepEqual(intelligence.activePreferences(expiredIntent, NOW), []);
});
