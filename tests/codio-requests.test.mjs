import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const js=ts.transpileModule(await readFile(new URL("../app/codio-requests.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {loadLyricsWithRetry}=await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
test("lyrics success, genuine empty response, and network failures are different states",async()=>{
  const signal=new AbortController().signal;let calls=0;
  assert.equal((await loadLyricsWithRetry(async()=>[{time:1,text:"line"}],signal)).status,"ready");
  assert.equal((await loadLyricsWithRetry(async()=>{calls++;return [];},signal)).status,"unavailable");assert.equal(calls,1);
  const waits=[];const failed=await loadLyricsWithRetry(async()=>{calls++;throw Error("network");},signal,async ms=>waits.push(ms));
  assert.equal(failed.status,"failed");assert.equal(failed.attempts,3);assert.deepEqual(waits,[750,1500]);assert.equal(calls,4);
});
test("switching track cancels backoff and old in-flight results cannot write to new lyrics",async()=>{
  const control=new AbortController();let resolve;
  const pending=loadLyricsWithRetry(()=>new Promise(r=>resolve=r),control.signal);
  control.abort();resolve([{time:0,text:"old track"}]);const result=await pending;assert.equal(result.status,"cancelled");assert.deepEqual(result.lines,[]);
  let calls=0;const another=new AbortController();const cancelled=await loadLyricsWithRetry(async()=>{calls++;throw Error();},another.signal,async()=>another.abort());
  assert.equal(cancelled.status,"cancelled");assert.equal(calls,1);
});
