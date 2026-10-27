import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(compile(await readFile(new URL("../app/listening-intelligence.ts", import.meta.url), "utf8"))).toString("base64")}`);
const NOW = Date.UTC(2026, 9, 23, 8);
const unknown = () => ({ value: null, source: "audio_analysis", confidence: 0, profileEligible: false });
// Synthetic, fixed evidence tests mathematical policy, not any real song's sound.
function candidate(id, genres, artist = `Artist ${id}`) {
  return { canonicalKey: `qq:${id}`, track: { provider: "qq", id, artist, title: id }, source: "adjacent_discovery",
    generationReason: "isolated evidence", sourceConfidence: .95, alreadyHeard: false, alreadyRecommended: false, inLibrary: false, playable: true,
    featureVector: { provider: "qq", trackId: id, artist, tags: genres.map(value => ({ value, source: "provider_metadata", confidence: .65, profileEligible: true })),
      bpm: unknown(), energy: unknown(), vocalFocus: unknown(), instrumentalFocus: unknown(), transitionFocus: unknown(),
      inLibrary: false, likedInProvider: false, artistFamiliarity: 0, playlistMembership: [], playCount: 0,
      novelty: { value: .8, source: "library_behavior", confidence: .8, profileEligible: false }, metadataConfidence: .95 } };
}
function like(memory, item, value = "more") {
  return api.recordListeningEvent(memory, { type: "preference_changed", eventId: `pref-${memory.rawEvents.length}`, targetType: "track",
    targetKey: item.canonicalKey, title: item.track.title, artist: item.track.artist, features: item.featureVector,
    value, scope: "track", source: "dj", createdAt: NOW + memory.rawEvents.length, sessionId: memory.currentSession.sessionId });
}
const empty = () => api.createEmptyListeningMemory(NOW);
const score = (item, memory, options = {}) => api.scoreCandidate(item, api.deriveListeningProfile(memory, NOW), memory, "match", NOW, options);
const similarity = value => value.contributions.find(part => part.key === "verified_track_similarity").signedWeight;

test("a coherent cross-artist song outranks a tag-stuffed hybrid; one shared word cannot buy close fit", t => {
  const memory = like(empty(), candidate("anchor", ["genre:neo-soul", "language:英语"]));
  const close = candidate("close", ["genre:neo-soul", "language:英语"]);
  const hybrid = candidate("hybrid", ["genre:neo-soul", "genre:industrial", "genre:death-metal", "genre:hardcore", "language:英语"]);
  const unrelated = candidate("unrelated", ["genre:techno", "language:英语"]);
  const ranked = [close, hybrid, unrelated].map(item => score(item, memory));
  assert.ok(similarity(ranked[0]) > similarity(ranked[1]) * 3);
  assert.equal(ranked[0].laneEvidence.match, true);
  assert.equal(ranked[1].laneEvidence.match, false);
  assert.equal(ranked[1].laneEvidence.frontier, true);
  assert.equal(ranked[2].laneEvidence.frontier, false);
  assert.deepEqual(api.composeRecommendations([hybrid, unrelated, close], new Map(ranked.map(s => [s.candidateKey, s])), "match", 12), [close]);
  t.diagnostic(JSON.stringify(ranked.map(s => ({ id: s.candidateKey, similarity: similarity(s), total: s.totalScore, match: s.laneEvidence.match, frontier: s.laneEvidence.frontier }))));
});

test("hundreds of broad likes cannot swamp a small distinct interest or stack without bound", () => {
  const rare = candidate("rare-anchor", ["genre:neo-soul"]), item = candidate("rare-new", ["genre:neo-soul"]);
  let memory = like(empty(), rare);
  const before = similarity(score(item, memory));
  for (let i = 0; i < 120; i++) memory = like(memory, candidate(`pop-${i}`, ["genre:pop", "language:英语"]));
  assert.equal(similarity(score(item, memory)), before);
  const broad = score(candidate("pop-new", ["genre:pop", "language:英语"]), memory);
  assert.ok(similarity(broad) < before / 3);
  assert.equal(broad.laneEvidence.match, false);
  const twice = like(like(empty(), candidate("one", ["genre:neo-soul"])), candidate("two", ["genre:neo-soul"]));
  let many = twice;
  for (let i = 0; i < 120; i++) many = like(many, candidate(`same-${i}`, ["genre:neo-soul"]));
  assert.equal(similarity(score(item, many)), similarity(score(item, twice)));
});

test("library evidence and actual completed songs connect other artists, not just exact likes", () => {
  const anchor = candidate("library", ["genre:neo-soul"]), item = candidate("other", ["genre:neo-soul"]);
  const feature = { ...anchor.featureVector, inLibrary: true, likedInProvider: true };
  const options = { libraryFeatures: [feature] };
  assert.ok(similarity(score(item, empty(), options)) > 0);
  assert.equal(score(item, empty(), options).laneEvidence.match, true);
  const memory = api.recordListeningEvent(empty(), { type: "play_settled", eventId: "settled", sessionId: "session", trackKey: anchor.canonicalKey,
    provider: "qq", providerTrackId: anchor.track.id, title: anchor.track.title, artist: anchor.track.artist, features: anchor.featureVector,
    startedAt: NOW - 200000, settledAt: NOW, listenedSeconds: 200, durationSeconds: 220, completionRatio: 200 / 220,
    exitReason: "ended", source: "recommendation_match", metadataConfidence: .95 });
  assert.ok(similarity(score(item, memory)) > 0);
  assert.equal(score(item, memory).laneEvidence.match, true);
  const failed = api.recordListeningEvent(empty(), { ...memory.rawEvents[0], eventId: "failed", exitReason: "error" });
  assert.equal(similarity(score(item, failed)), 0);
  assert.equal(score(item, failed).laneEvidence.match, false);
});

test("one work present as a like, library item and listen is one neighbor, and withdrawal restores evidence", () => {
  const anchor = candidate("one", ["genre:neo-soul"]), item = candidate("other", ["genre:neo-soul"]);
  const memory = like(empty(), anchor), options = { libraryFeatures: [{ ...anchor.featureVector, inLibrary: true }] };
  assert.equal(similarity(score(item, memory, options)), similarity(score(item, memory)));
  const disliked = like(memory, anchor, "less");
  assert.ok(similarity(score(item, disliked, options)) <= 0);
  assert.equal(score(item, disliked, options).laneEvidence.match, false);
  const withdrawn = like(disliked, anchor, "neutral");
  assert.equal(similarity(score(item, withdrawn, options)), similarity(score(item, empty(), options)), "the independent QQ collection remains; the removed DJ vote does not");
});

test("duplicate tags and unsupported hints never multiply taste evidence", () => {
  const anchor = candidate("one", ["genre:neo-soul"]), memory = like(empty(), anchor);
  const item = candidate("other", ["genre:neo-soul"]), repeated = structuredClone(item);
  repeated.featureVector.tags.push(...Array.from({ length: 12 }, () => ({ ...repeated.featureVector.tags[0] })));
  assert.equal(score(item, memory).totalScore, score(repeated, memory).totalScore);
  const guessed = structuredClone(item);
  guessed.featureVector.tags = [{ value: "genre:neo-soul", source: "artist_hint", confidence: .99, profileEligible: false }];
  assert.equal(similarity(score(guessed, memory)), 0);
  assert.equal(score(guessed, memory).laneEvidence.match, false);
});

test("broad language saturation remains weak, while additional specific listening still makes a measured difference", () => {
  const item = candidate("new", ["genre:neo-soul"]), broad = candidate("broad", ["genre:pop", "language:英语"]);
  const profile = api.deriveListeningProfile(empty(), NOW);
  profile.lifetimeProfile.tagAffinities = { "genre:neo-soul": 2, "genre:pop": 1000, "language:英语": 1000 };
  const value = target => api.scoreCandidate(target, profile, empty(), "match", NOW).contributions.find(part => part.key === "long_term_affinity").signedWeight;
  assert.ok(value(item) > value(broad) * 3);
  const before = value(item); profile.lifetimeProfile.tagAffinities["genre:neo-soul"] = 3;
  assert.ok(value(item) > before, "not already saturated after two observations");
});

test("BPM continuity cannot overturn a clear taste advantage and unverified BPM has no sequencing influence", () => {
  const first = candidate("first", ["genre:neo-soul"]), preferred = candidate("preferred", ["genre:neo-soul"]), weaker = candidate("weaker", ["genre:neo-soul"]);
  const items = [first, preferred, weaker];
  for (const item of items) item.featureVector.bpm = { value: item === preferred ? 160 : 80, source: "audio_analysis", confidence: .9, profileEligible: true };
  const make = () => new Map(items.map((item, index) => [item.canonicalKey, { ...score(item, like(empty(), candidate("anchor", ["genre:neo-soul"]))),
    totalScore: [5, 1.5, 1][index] }]));
  assert.deepEqual(api.composeRecommendations(items, make(), "match", 3).map(item => item.track.id), ["first", "preferred", "weaker"]);
  for (const item of items) item.featureVector.bpm = { ...item.featureVector.bpm, source: "artist_hint", profileEligible: false };
  const ranked = make(); api.composeRecommendations(items, ranked, "match", 3);
  assert.ok([...ranked.values()].every(s => s.contributions.filter(p => p.key === "composition_diversity").every(p => p.signedWeight >= -.12)), "no fabricated tempo penalty");
});

test("source balancing is bounded, deduplicated and leaves room for every retrieval source", () => {
  const sources = Array.from({ length: 8 }, (_, source) => Array.from({ length: 100 }, (_, row) => `${source}:${row}`));
  const selected = api.interleaveRecommendationSources(sources, id => id);
  assert.equal(selected.length, 120);
  for (let source = 0; source < 8; source++) assert.equal(selected.filter(id => id.startsWith(`${source}:`)).length, 15);
  assert.equal(new Set(api.interleaveRecommendationSources([sources[0], sources[0], [], sources[1]], id => id)).size, 120);
  assert.deepEqual(api.interleaveRecommendationSources([[], []], id => id), []);
});

test("the actual acquisition handler balances stable seed order, isolates failures, and filters already exposed/other-owned IDs", async () => {
  const text = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("RadioExperience.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  (function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "acquiredEntries") expression = node.initializer.getText(ast); ts.forEachChild(node, visit); })(ast);
  assert.ok(expression);
  const bind = new Function("context", `with(context) { ${compile(`const get = ${expression};`)} return get; }`);
  const tracks = source => Array.from({ length: 80 }, (_, row) => ({ mid: `${source}:${row}` }));
  const sources = [tracks("a"), tracks("b"), tracks("c")];
  const batches = sources.map((tracks, i) => ({ seed: { key: `seed-${i}` }, tracks }));
  const context = { seeds: batches.map(batch => batch.seed), acquisition: [batches[2], batches[0], batches[1]],
    entries: new Map(sources.flat().map(track => [track.mid, { track }])),
    recommendationIdentity: track => track.mid, interleaveRecommendationSources: api.interleaveRecommendationSources,
    otherOwnedKeys: () => new Set(["a:0"]), exposed: new Set(["a:1"]), checkedKeys: new Set(["b:0"]),
    lane: "frontier", seedLibrary: [], retainedTracks: new Map() };
  const get = bind(context), first = get().map(entry => entry.track.mid);
  assert.deepEqual(first.slice(0, 3), ["a:2", "b:1", "c:0"]);
  context.acquisition = batches;
  assert.deepEqual(get().map(entry => entry.track.mid), first, "network completion order must not determine who gets scored");
  context.acquisition = [batches[0], { ...batches[1], tracks: [] }, batches[2]];
  assert.equal(get().length, 120, "one failed source leaves the remaining sources usable");
  assert.ok(get().every(entry => !entry.track.mid.startsWith("b:")));
});
