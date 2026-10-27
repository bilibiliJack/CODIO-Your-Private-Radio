import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const { readLibrarySnapshot, likedEvidence, confirmFavoritePlaylist }=createRequire(import.meta.url)("../desktop/codio-qq-library.cjs");
const dir=await mkdtemp(path.join(os.tmpdir(),"codio-qq-library-test-"));
after(async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});});
const song={mid:"real-id-fixture",title:"Fixture",artist:"Artist",provider:"qq"};
test("provider favorite relationship and all playlist IDs survive deduplication",async()=>{
  const request=async(kind)=>kind==="list"?{code:0,data:{disslist:[{tid:1,name:"Renamed",type:"liked",song_cnt:1},{tid:2,name:"Playlist",song_cnt:1}]}}:{code:0,cdlist:[{songlist:[song]}]};
  const result=await readLibrarySnapshot({request,mapTrack:x=>x,cacheFile:path.join(dir,"relations.json")});
  assert.equal(result.tracks.length,1);assert.equal(result.tracks[0].likedInProvider,true);assert.equal(result.likedCount,1);
  assert.deepEqual(result.tracks[0].playlistMembership.map(p=>p.id),["1","2"]);assert.equal(result.coverage.partial,false);
});
test("renameable favorites name remains a weak hint, never official liked fact",()=>{
  assert.deepEqual(likedEvidence({name:"我喜欢"}),{source:"playlist_name_hint",confidence:.3,confirmed:false});
  assert.equal(likedEvidence({name:"Anything",is_liked:true}).confirmed,true);
});

test("explicit user confirmation is persisted by exact playlist identity and survives a rename and resync",async()=>{
  const cacheFile=path.join(dir,"confirmed.json");let name="我喜欢";
  const request=async kind=>kind==="list"?{code:0,data:{disslist:[{tid:"confirmed",name,song_cnt:1},{tid:"ordinary",name:"Other",song_cnt:1}]}}:
    {code:0,cdlist:[{songlist:[song]}]};
  const original=await readLibrarySnapshot({cacheFile,mapTrack:x=>x,request});assert.equal(original.likedCount,0);
  assert.equal((await confirmFavoritePlaylist(cacheFile,"confirmed")).likedCount,1);
  const saved=JSON.parse(await readFile(cacheFile,"utf8"));assert.equal(saved.tracks[0].likedEvidence.source,"user_confirmation");
  assert.deepEqual(saved.tracks.map(track=>track.mid),original.tracks.map(track=>track.mid));
  name="Renamed by user";
  const next=await readLibrarySnapshot({cacheFile,mapTrack:x=>x,request,force:true});
  assert.equal(next.likedCount,1);assert.equal(next.playlists.find(p=>p.id==="confirmed").likedEvidence.source,"user_confirmation");
  assert.equal(next.playlists.find(p=>p.id==="ordinary").likedEvidence.confirmed,false);
  await assert.rejects(()=>confirmFavoritePlaylist(cacheFile,"not-present"),/CONFIRMATION_INVALID/);
});
test("partial detail and total list failures preserve the previously read valid relationships",async()=>{
  const cacheFile=path.join(dir,"retain.json");const list={code:0,data:{disslist:[{tid:3,name:"Known",song_cnt:1}]}};
  await readLibrarySnapshot({cacheFile,mapTrack:x=>x,request:async kind=>kind==="list"?list:{code:0,cdlist:[{songlist:[song]}]}});
  const partial=await readLibrarySnapshot({cacheFile,force:true,mapTrack:x=>x,request:async kind=>{if(kind==="list")return list;throw Error("network");}});
  assert.equal(partial.tracks[0].mid,song.mid);assert.equal(partial.coverage.retainedPlaylists,1);assert.equal(partial.coverage.partial,true);
  const failure=await readLibrarySnapshot({cacheFile,mapTrack:x=>x,request:async()=>{throw Error("network");}});
  assert.equal(failure.tracks.length,1);assert.equal(failure.coverage.listComplete,false);
});
test("pagination is bounded and coverage does not describe capped/partial reads as complete",async()=>{
  let active=0,max=0,lists=0;
  const result=await readLibrarySnapshot({cacheFile:path.join(dir,"pages.json"),mapTrack:x=>x,request:async(kind,{offset})=>{
    if(kind==="list"){lists++;return {code:0,data:{total:200,disslist:Array.from({length:100},(_,i)=>({tid:offset+i+1,name:"p",song_cnt:1500}))}};}
    active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return {code:0,cdlist:[{songlist:[song],total_song_num:1500}]};
  }});
  assert.equal(lists,2);assert.equal(result.coverage.readPlaylistCount,120);assert.equal(result.coverage.listComplete,false);
  assert.equal(max,3);assert.equal(result.coverage.partial,true);
});

test("fresh complete real snapshot bypasses all provider calls and reports its unchanged age", async () => {
  const cacheFile = path.join(dir, "fresh.json");
  let clock = 1000000, calls = 0;
  const request = async kind => {
    calls++;
    return kind === "list" ? { code: 0, data: { disslist: [{ tid: 8, name: "Actual fixture", song_cnt: 1 }] } }
      : { code: 0, cdlist: [{ songlist: [song] }] };
  };
  const options = { cacheFile, request, mapTrack: x => x, ttlMs: 1000, now: () => clock };
  const fresh = await readLibrarySnapshot(options);
  assert.equal(fresh.cache.source, "provider");
  assert.equal(calls, 2);
  const saved = await readFile(cacheFile, "utf8");
  clock += 999;
  const cached = await readLibrarySnapshot(options);
  assert.equal(calls, 2, "a returning startup sends no list or playlist detail requests inside TTL");
  assert.deepEqual(cached.cache, { source: "snapshot", ageMs: 999, ttlMs: 1000 });
  assert.equal(cached.coverage.syncedAt, fresh.coverage.syncedAt);
  assert.deepEqual(cached.tracks, fresh.tracks);
  assert.equal(await readFile(cacheFile, "utf8"), saved, "cache hits do not rewrite sync timestamps or user playlist evidence");
  clock += 1;
  const expired = await readLibrarySnapshot(options);
  assert.equal(calls, 4);
  assert.equal(expired.cache.source, "provider");
  assert.equal(expired.coverage.syncedAt, clock);
});

test("literal force bypasses a fresh snapshot while malformed truthy flags do not", async () => {
  const cacheFile = path.join(dir, "force.json");
  let calls = 0;
  const request = async kind => {
    calls++;
    return kind === "list" ? { code: 0, data: { disslist: [{ tid: 9, name: "Actual", song_cnt: 1 }] } }
      : { code: 0, cdlist: [{ songlist: [song] }] };
  };
  const options = { cacheFile, request, mapTrack: x => x };
  await readLibrarySnapshot(options);
  for (const force of [false, undefined, "true", 1]) {
    assert.equal((await readLibrarySnapshot({ ...options, force })).cache.source, "snapshot");
  }
  assert.equal(calls, 2);
  assert.equal((await readLibrarySnapshot({ ...options, force: true })).cache.source, "provider");
  assert.equal(calls, 4);
});

test("partial snapshots and future timestamps never manufacture a fresh complete cache hit", async () => {
  const cacheFile = path.join(dir, "not-complete.json");
  const clock = 1000000;
  let calls = 0;
  const request = async kind => {
    calls++;
    return kind === "list" ? { code: 0, data: { disslist: [] } } : assert.fail("empty list has no detail");
  };
  const options = { cacheFile, request, mapTrack: x => x, now: () => clock };
  await writeFile(cacheFile, JSON.stringify({ playlists: [], tracks: [], coverage: { partial: true, listComplete: true, syncedAt: clock } }));
  assert.equal((await readLibrarySnapshot(options)).cache.source, "provider");
  await writeFile(cacheFile, JSON.stringify({ playlists: [], tracks: [], coverage: { partial: false, listComplete: true, syncedAt: clock + 10 } }));
  assert.equal((await readLibrarySnapshot(options)).cache.source, "provider");
  assert.equal(calls, 2);
});
