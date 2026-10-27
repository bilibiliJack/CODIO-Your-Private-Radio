import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Run the production component with isolated hooks/geometry. Clock authority
// remains the player's job; this checks that the scroller does not invent a cue.
const source = await readFile(new URL("../app/LyricsScroller.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("LyricsScroller.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "LyricsScroller");
assert.ok(declaration);
const javascript = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const bind = new Function("context", `with(context) { ${javascript}; return LyricsScroller; }`);
const lines = [{ time: 15, text: "First timed line" }, { time: 30, text: "Second timed line" }, { time: 45, text: "Third timed line" }];
function harness() {
  const refs = [], callbacks = [], effects = [], scrolls = [], childIndices = [];
  let refIndex = 0, callbackIndex = 0, effectIndex = 0, queued = [];
  const viewport = { clientWidth: 600, clientHeight: 300, scrollTo: value => scrolls.push(value) };
  const track = { style: { setProperty() {} }, children: { item(index) { childIndices.push(index); return { offsetTop: 150 + index * 40, offsetHeight: 30 }; } } };
  const same = (a, b) => a?.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const context = {
    ResizeObserver: undefined,
    React: { createElement(type, props, ...children) { return { type, props: props || {}, children }; } },
    useRef(initial) {
      const index = refIndex++;
      return refs[index] ||= { current: index === 0 ? viewport : index === 1 ? track : initial };
    },
    useCallback(callback, dependencies) {
      const index = callbackIndex++;
      if (!same(callbacks[index]?.dependencies, dependencies)) callbacks[index] = { callback, dependencies };
      return callbacks[index].callback;
    },
    useLayoutEffect(callback, dependencies) {
      const index = effectIndex++;
      if (!same(effects[index]?.dependencies, dependencies)) {
        effects[index]?.cleanup?.();
        const effect = { dependencies }; effects[index] = effect;
        queued.push(() => { effect.cleanup = callback(); });
      }
    },
  };
  const component = bind(context);
  return {
    scrolls, childIndices,
    render(overrides = {}) {
      refIndex = callbackIndex = effectIndex = 0; queued = [];
      const tree = component({ lines, activeIndex: -1, variant: "feature", enabled: true, reducedMotion: false, trackKey: "track-one", ...overrides });
      for (const run of queued) run();
      return tree;
    },
  };
}
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  return [node, ...node.children.flatMap(elements)];
}
const currentLines = tree => elements(tree).filter(node => node.props["aria-current"] === "true");

test("instrumental intro before the first timed cue has no falsely current line", () => {
  const h = harness(), tree = h.render({ activeIndex: -1 });
  assert.equal(currentLines(tree).length, 0);
  assert.equal(h.childIndices.at(-1), 1, "keep the first actual line in view, never position the decorative spacer");
  assert.equal(h.scrolls.at(-1).behavior, "auto");
});

test("first actual cue activates the first lyric rather than requiring a later cue", () => {
  const h = harness(); h.render({ activeIndex: -1 });
  const tree = h.render({ activeIndex: 0 });
  assert.deepEqual(currentLines(tree).map(node => node.children[0]), ["First timed line"]);
  assert.equal(h.childIndices.at(-1), 1);
});

test("rendered lyric timestamps expose the actual input cues without changing them", () => {
  const h = harness(), tree = h.render({ activeIndex: 1 });
  const rows = elements(tree).filter(node => node.props["data-lyric-time"] !== undefined);
  assert.deepEqual(rows.map(node => node.props["data-lyric-time"]), lines.map(line => line.time));
  assert.equal(currentLines(tree)[0].props["data-lyric-time"], 30);
});

test("pause/resume and repeated unchanged player samples cannot restart lyric scrolling", () => {
  const h = harness(); h.render({ activeIndex: 1 });
  const count = h.scrolls.length;
  for (let sample = 0; sample < 25; sample++) h.render({ activeIndex: 1 });
  assert.equal(h.scrolls.length, count);
});

test("seek backwards into the intro clears current lyrics and positions safely", () => {
  const h = harness(); h.render({ activeIndex: 2 });
  const tree = h.render({ activeIndex: -1 });
  assert.equal(currentLines(tree).length, 0);
  assert.equal(h.scrolls.at(-1).behavior, "auto");
  assert.equal(h.childIndices.at(-1), 1);
});

test("seek jumps select the supplied real media cue immediately rather than animating through old cues", () => {
  const h = harness(); h.render({ activeIndex: 0 });
  const tree = h.render({ activeIndex: 2 });
  assert.deepEqual(currentLines(tree).map(node => node.children[0]), ["Third timed line"]);
  assert.equal(h.scrolls.at(-1).behavior, "auto");
});

test("ordinary one-line advance retains smooth scrolling", () => {
  const h = harness(); h.render({ activeIndex: 0 }); h.render({ activeIndex: 1 });
  assert.equal(h.scrolls.at(-1).behavior, "smooth");
});

test("reopening either Now Playing layout uses the latest supplied cue, not the old hidden cue", () => {
  for (const variant of ["feature", "fullscreen"]) {
    const h = harness(); h.render({ variant, enabled: false, activeIndex: 0 });
    h.render({ variant, enabled: false, activeIndex: 2 });
    const tree = h.render({ variant, enabled: true, activeIndex: 2 });
    assert.deepEqual(currentLines(tree).map(node => node.children[0]), ["Third timed line"]);
    assert.equal(h.scrolls.at(-1).behavior, "auto");
  }
});

test("track identity changes with a delayed first cue do not keep the previous song highlighted", () => {
  const h = harness(); h.render({ activeIndex: 2 });
  const next = [{ time: 20, text: "Different song" }];
  const tree = h.render({ lines: next, trackKey: "track-two", activeIndex: -1 });
  assert.equal(currentLines(tree).length, 0); assert.equal(h.scrolls.at(-1).behavior, "auto");
  const visible = elements(tree).filter(node => node.props.className?.includes("codio-lyric-line"));
  assert.deepEqual(visible.map(node => node.children[0]), ["Different song"]);
});

test("reduced motion and out-of-range indices keep one valid supplied current line", () => {
  const h = harness(); h.render({ activeIndex: 0, reducedMotion: true });
  const tree = h.render({ activeIndex: 99, reducedMotion: true });
  assert.deepEqual(currentLines(tree).map(node => node.children[0]), ["Third timed line"]);
  assert.equal(h.scrolls.at(-1).behavior, "auto");
});
