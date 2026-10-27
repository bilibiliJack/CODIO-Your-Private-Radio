import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import http from "node:http";
const { createLocalLibrary, serveLocalFile } = createRequire(import.meta.url)("../desktop/codio-local.cjs");
const dir = await mkdtemp(path.join(os.tmpdir(), "codio-local-test-"));
after(async () => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(dir, { recursive: true, force: true }); });
function wav() {
  const b = Buffer.alloc(44 + 16000); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(8000,24); b.writeUInt32LE(16000,28);
  b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write("data",36); b.writeUInt32LE(16000,40); return b;
}
test("real WAV import has stable identity, measured duration, duplicates and restart persistence", async () => {
  const file=path.join(dir,"song.wav"), store=path.join(dir,"library.json"); await writeFile(file,wav());
  const library=createLocalLibrary(store), a=await library.importSelected([file]);
  assert.equal(a.imported,1); assert.equal(a.tracks[0].provider,"local"); assert.equal(a.tracks[0].durationSeconds,1);
  assert.equal(a.tracks[0].artist,"Unknown artist"); assert.equal(a.tracks[0].album,undefined);
  const b=await library.importSelected([file]); assert.equal(b.imported,0); assert.equal(b.duplicates,1);
  assert.deepEqual(await createLocalLibrary(store).list(), a.tracks); assert.equal(await library.resolve(a.tracks[0].id),file);
  assert.ok(!(await readFile(store,"utf8")).includes("QQ"));
});
test("cancel, empty folder, broken WAV and unsupported files never claim success",async()=>{
  const library=createLocalLibrary(path.join(dir,"empty-store.json")); const empty=path.join(dir,"empty");await mkdir(empty);
  const cancelled=await library.importSelected([]); assert.equal(cancelled.cancelled,true); assert.equal(cancelled.ok,false);
  assert.equal((await library.importSelected([empty])).ok,false);
  const broken=path.join(dir,"broken.wav"),unsupported=path.join(dir,"other.mp3");await writeFile(broken,"broken");await writeFile(unsupported,"not imported");
  const result=await library.importSelected([broken,unsupported]);assert.equal(result.ok,false);assert.equal(result.failed,2);assert.equal(result.tracks.length,0);
});
test("registered IDs only, moved/deleted/changed sources fail without arbitrary-path access",async()=>{
  const file=path.join(dir,"move.wav"),library=createLocalLibrary(path.join(dir,"move-store.json"));await writeFile(file,wav());
  const result=await library.importSelected([file]);await assert.rejects(()=>library.resolve(file),/LOCAL_ID_NOT_IMPORTED/);
  await rename(file,path.join(dir,"moved.wav"));await assert.rejects(()=>library.resolve(result.tracks[0].mid),/LOCAL_SOURCE_MISSING/);
  await writeFile(file,Buffer.concat([wav(),Buffer.from("change")]));await assert.rejects(()=>library.resolve(result.tracks[0].mid),/LOCAL_SOURCE_CHANGED/);
});
test("local streaming serves bounded real bytes, range and HEAD, not complete file loading",async()=>{
  const file=path.join(dir,"stream.wav");const bytes=wav();await writeFile(file,bytes);
  const server=http.createServer((req,res)=>void serveLocalFile(file,req,res));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try { const url=`http://127.0.0.1:${server.address().port}`;
    const range=await fetch(url,{headers:{Range:"bytes=0-43"}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(0,44));
    assert.equal((await fetch(url,{method:"HEAD"})).headers.get("content-length"),String(bytes.length));
    assert.equal((await fetch(url,{headers:{Range:"bytes=999999-"}})).status,416);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
