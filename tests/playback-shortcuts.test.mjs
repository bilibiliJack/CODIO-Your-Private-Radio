import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the actual renderer handlers, without loading QQ or changing user data.
const source = await readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("RadioExperience.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ["handlePlaybackShortcut", "blockSpaceRelease"].includes(node.name.getText(ast))) {
    declarations.set(node.name.getText(ast), node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function harness(bootPhase = "done") {
  let calls = 0;
  const make = (name) => {
    assert.ok(declarations.has(name), `Missing real renderer handler: ${name}`);
    const js = ts.transpileModule(`const handler = ${declarations.get(name)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function("bootPhase", "togglePlayback", `${js}; return handler;`)(bootPhase, () => { calls += 1; });
  };
  return { down: make("handlePlaybackShortcut"), up: make("blockSpaceRelease"), calls: () => calls };
}
function key({ repeat = false, editable = false, code = "Space", key = " " } = {}) {
  return {
    code, key, repeat, prevented: false, stopped: false,
    target: { closest: () => editable ? {} : null },
    preventDefault() { this.prevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() { this.stopped = true; },
  };
}
test("space keydown executes once; keyup prevents a second native button activation", () => {
  const h = harness(); const down = key(); const up = key();
  h.down(down); h.up(up);
  assert.equal(h.calls(), 1);
  assert.ok(down.prevented && down.stopped && up.prevented && up.stopped);
});
test("held space never scrolls or repeats playback actions", () => {
  const h = harness(); h.down(key());
  for (let i = 0; i < 12; i += 1) { const event = key({ repeat: true }); h.down(event); assert.ok(event.prevented && event.stopped); }
  assert.equal(h.calls(), 1);
});
test("text editing and startup retain their native space behavior", () => {
  for (const h of [harness(), harness("ready")]) {
    const editing = key({ editable: true }); h.down(editing); h.up(editing);
    assert.equal(editing.prevented, false); assert.equal(h.calls(), 0);
  }
  const h = harness("ready"); const event = key(); h.down(event); h.up(event);
  assert.equal(h.calls(), 0); assert.equal(event.prevented, false);
});
test("non-space keys are not intercepted", () => {
  const h = harness(); const event = key({ code: "Enter", key: "Enter" }); h.down(event); h.up(event);
  assert.equal(h.calls(), 0); assert.equal(event.prevented, false);
});
