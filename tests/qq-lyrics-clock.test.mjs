import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import lyricsModule from "../desktop/codio-lyrics.cjs";

// Execute the desktop's actual QQ response parser with an isolated session.
// The tests never start Electron or read the user's login, Key or music data.
const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ["fetchQQSessionJson", "decodeQQLyric", "readQQLyrics"];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(functions.length, names.length);
const bind = new Function("context", `with(context){${functions.map(node => node.getText(ast)).join("\n")};return readQQLyrics;}`);
function harness(lyric, { responseOk = true, code = 0, modern, primaryError } = {}) {
  const requests = [], timers = new Map(); let sequence = 0;
  const context = {
    QQ_LYRIC_URL: "https://qq.example.invalid/lyrics", USER_AGENT: "isolated-test",
    QQ_MUSICU_URL: "https://qq.example.invalid/musicu", AbortController, ...lyricsModule,
    qqLyricCache: new Map(), qqLyricPending: new Map(),
    async readQQAuth() {
      return { qqSession: { async fetch(url, options) {
        requests.push({ url: new URL(url), options });
        const isModern = new URL(url).pathname === "/musicu";
        if (!isModern && primaryError) throw primaryError;
        return { ok: responseOk, status: responseOk ? 200 : 503, json: async () => isModern
          ? modern || { code, req_0: { code, data: { lyric } } } : { code, lyric } };
      } } };
    },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  return { read: bind(context), requests, timers, context };
}
const track = { mid: "verifiedSongIdentity", id: "differentFallbackId", title: "A title is not an identity" };

test("QQ lyrics keep exact songmid identity, original milliseconds and sorted multiple cues", async () => {
  const h = harness("[01:00.123]later\n[00:10.5][00:20:25]same &amp; text\n[ti:ignored]");
  assert.deepEqual(await h.read(null, track), [
    { time: 10.5, text: "same & text" }, { time: 20.25, text: "same & text" }, { time: 60.123, text: "later" },
  ]);
  assert.equal(h.requests[0].url.searchParams.get("songmid"), track.mid);
  assert.equal(h.requests[0].url.searchParams.get("nobase64"), "1");
  assert.equal(h.requests[0].options.signal.aborted, false);
  assert.equal(h.timers.size, 0);
});

test("positive LRC offset advances every cue rather than delaying it", async () => {
  const h = harness("[offset:+1500]\n[00:10.000][00:20.250]line");
  assert.deepEqual(await h.read(null, track), [{ time: 8.5, text: "line" }, { time: 18.75, text: "line" }]);
});

test("negative LRC offset delays every cue", async () => {
  const h = harness("[offset:-1500]\n[00:10.000]line");
  assert.deepEqual(await h.read(null, track), [{ time: 11.5, text: "line" }]);
});

test("global offset at the end also applies to preceding rows", async () => {
  const h = harness("[00:10.000]line\n[OFFSET: 500 ]");
  assert.deepEqual(await h.read(null, track), [{ time: 9.5, text: "line" }]);
});

test("valid offset metadata is honored in base64 QQ responses", async () => {
  const h = harness(Buffer.from("[offset:250]\n[00:01.000]base64").toString("base64"));
  assert.deepEqual(await h.read(null, track), [{ time: .75, text: "base64" }]);
});

test("malformed or unsafe offset values cannot corrupt valid timestamps", async () => {
  const h = harness("[offset:NaN]\n[offset:9999999999999999999999]\n[00:10.000]line");
  assert.deepEqual(await h.read(null, track), [{ time: 10, text: "line" }]);
});

test("last valid offset metadata wins without malformed metadata undoing it", async () => {
  const h = harness("[offset:500]\n[offset:-750]\n[offset:invalid]\n[00:10.000]line");
  assert.deepEqual(await h.read(null, track), [{ time: 10.75, text: "line" }]);
});

test("a cue advanced before zero is preserved and has no fabricated intro delay", async () => {
  const h = harness("[offset:1500]\n[00:01.000]already singing\n[00:03.000]next");
  assert.deepEqual(await h.read(null, track), [{ time: -.5, text: "already singing" }, { time: 1.5, text: "next" }]);
});

test("local or missing identities never make a title-based QQ lyric request", async () => {
  const h = harness("[00:01.000]line");
  assert.deepEqual(await h.read(null, { provider: "local", mid: "local" }), []);
  assert.deepEqual(await h.read(null, { title: "ambiguous title" }), []);
  assert.equal(h.requests.length, 0);
});

test("provider and network errors remain errors and release timeout resources", async () => {
  for (const [options, error] of [[{ responseOk: false }, "QQ_LYRICS_503"], [{ code: 1 }, "QQ_LYRICS_PROVIDER_FAILED"]]) {
    const h = harness("[00:01.000]line", options);
    await assert.rejects(h.read(null, track), { message: error });
    assert.equal(h.timers.size, 0);
  }
});

test("a QRC-only release falls back using the exact same MID and converts its original millisecond cues", async () => {
  const qrc='<?xml version="1.0"?><QrcInfos><Lyric_1 LyricType="1" LyricContent="[offset:250]\n[47259,5752]A(47259,500) line(47759,5252)\n[53011,4184]Next(53011,4184)"/></QrcInfos>';
  const h=harness("",{code:-1901,modern:{code:0,req_0:{code:0,data:{songID:7220007,lyric:Buffer.from(qrc).toString("base64")}}}});
  assert.deepEqual(await h.read(null,track),[{time:47.009,text:"A line"},{time:52.761,text:"Next"}]);
  assert.equal(h.requests.length,2);
  const request=JSON.parse(h.requests[1].url.searchParams.get("data"));
  assert.equal(request.req_0.param.songMid,track.mid);assert.equal(request.req_0.param.qrc,1);
  assert.equal(request.req_0.module,"music.musichallSong.PlayLyricInfo");assert.equal(request.req_0.method,"GetPlayLyricInfo");
  assert.ok(h.requests.every(request=>request.options.credentials==="include"));assert.equal(h.timers.size,0);
});

test("quoted QRC text, entity line breaks and word timings cannot truncate later verses",()=>{
  const xml='<QrcInfos><Lyric_1 LyricType="1" LyricContent="[1000,2000]Say(1000,500) "hello"(1500,1500)&#10;[5000,1000]再(5000,500)见(5500,500)&#xD;[7000,1000]&quot;last&quot;(7000,1000)"/></QrcInfos>';
  assert.deepEqual(lyricsModule.parseQQLyrics(xml),[{time:1,text:'Say "hello"'},{time:5,text:"再见"},{time:7,text:'"last"'}]);
});

test("fixed synthetic QRC ciphertext decodes through the real compatibility codec and keeps its line clock",()=>{
  const ciphertext="ee7befb746f93831d42dcdf2e21f0d5d924943e250c9b32f6d731ce7c8a4cd0194c8c4478d0dc76704a90d1f53f1240ec601330b17498c9dabb61f5c1327792b9bcd80e345e59da7";
  assert.deepEqual(lyricsModule.parseQQLyrics(lyricsModule.decryptQRC(ciphertext)),[{time:1,text:"fixture"}]);
  assert.throws(()=>lyricsModule.decryptQRC(`ff${ciphertext.slice(2)}`));
});

test("empty or failed legacy responses can recover through QRC, with no title search or different-version fallback",async()=>{
  for(const primaryError of [undefined,Error("isolated connection reset")]){
    const h=harness("",{primaryError,modern:{code:0,req_0:{code:0,data:{lyric:"[00:12.25]same identity"}}}});
    assert.deepEqual(await h.read(null,track),[{time:12.25,text:"same identity"}]);assert.equal(h.requests.length,2);
    assert.ok(h.requests.every(request=>!request.url.searchParams.has("w")));assert.equal(h.timers.size,0);
  }
});

test("success is shared by concurrent handoff/current requests and cached only under the exact identity",async()=>{
  const h=harness("[00:01]one"),other={mid:"anotherExactVersion"};
  const [a,b]=await Promise.all([h.read(null,track),h.read(null,track)]);
  assert.deepEqual(a,b);assert.equal(h.requests.length,1);assert.equal(h.context.qqLyricPending.size,0);
  assert.deepEqual(await h.read(null,track),a);assert.equal(h.requests.length,1);
  await h.read(null,other);assert.equal(h.requests.length,2);assert.equal(h.context.qqLyricCache.size,2);
});

test("unavailable lyrics and failures are not cached as success or mislabeled instrumental, and can recover",async()=>{
  const unavailable=harness("");assert.deepEqual(await unavailable.read(null,track),[]);
  assert.equal(unavailable.context.qqLyricCache.size,0);await unavailable.read(null,track);assert.equal(unavailable.requests.length,4);
  const failed=harness("",{code:1});await assert.rejects(failed.read(null,track));
  assert.equal(failed.context.qqLyricPending.size,0);assert.equal(failed.context.qqLyricCache.size,0);
  failed.context.qqLyricCache.set(track.mid,{lines:[{time:2,text:"recovered"}],expiresAt:Date.now()+10000});
  assert.deepEqual(await failed.read(null,track),[{time:2,text:"recovered"}]);
});

test("lyric cache is bounded and expired entries require a fresh exact-version request",async()=>{
  const h=harness("[00:01]one");
  for(let i=0;i<70;i++)await h.read(null,{mid:`song${i}`});
  assert.equal(h.context.qqLyricCache.size,64);assert.equal(h.context.qqLyricCache.has("song0"),false);
  const entry=h.context.qqLyricCache.get("song69");entry.expiresAt=0;
  await h.read(null,{mid:"song69"});assert.equal(h.requests.length,71);assert.equal(h.context.qqLyricCache.size,64);
});

test("invalid QRC payloads and unsafe identities are rejected without fabricated lyric rows",async()=>{
  for(const value of ["not hex","abcd","00".repeat(65537)])assert.throws(()=>lyricsModule.decryptQRC(value));
  const h=harness("[00:01]line");await assert.rejects(h.read(null,{mid:"../wrong"}),/QQ_LYRICS_ID_INVALID/);assert.equal(h.requests.length,0);
  assert.equal(lyricsModule.parseQQLyrics("[00:88]bad seconds").length,0);
  assert.throws(()=>lyricsModule.parseQQLyrics("x".repeat(512*1024+1)),/QQ_LYRICS_INVALID_FORMAT/);
});
