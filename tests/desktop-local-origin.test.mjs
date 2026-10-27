import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && ["reserveLocalPort", "reserveAppPort"].includes(node.name?.text)).map((node) => node.getText(ast)).join("\n");
assert.ok(functions.includes("async function reserveAppPort"));
const bind = new Function("app", "fs", "net", "path", `${functions}; return reserveAppPort;`);

test("desktop reuses one local origin across launches without writing credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codio-origin-test-"));
  try {
    const reserve = bind({ getPath: () => directory }, fs, net, path);
    const first = await reserve();
    const second = await reserve();
    assert.equal(first, second);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "codio-local-origin.json"), "utf8")), { version: 1, port: first });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("occupied desktop origin is rejected instead of switching to an empty storage origin", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codio-origin-test-"));
  const server = net.createServer();
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await writeFile(path.join(directory, "codio-local-origin.json"), JSON.stringify({ version: 1, port }));
    const reserve = bind({ getPath: () => directory }, fs, net, path);
    await assert.rejects(reserve(), /CODIO_LOCAL_PORT_IN_USE/);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "codio-local-origin.json"), "utf8")).port, port);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test("invalid local origin metadata fails safely and remains intact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codio-origin-test-"));
  try {
    const filename = path.join(directory, "codio-local-origin.json");
    await writeFile(filename, '{"port":-1}');
    await assert.rejects(bind({ getPath: () => directory }, fs, net, path)(), /CODIO_LOCAL_ORIGIN_INVALID/);
    assert.equal(await fs.readFile(filename, "utf8"), '{"port":-1}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
