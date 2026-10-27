const path = require("node:path");
const fs = require("node:fs/promises");
const esbuild = require("esbuild");

const projectRoot = path.join(__dirname, "..");
const standaloneRoot = path.join(projectRoot, "dist", "standalone");
const outputRoot = path.join(projectRoot, "build", "codio-server");

async function prepareDesktopServer() {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });
  const serverFile = path.join(outputRoot, "server.mjs");
  await esbuild.build({
    entryPoints: [path.join(standaloneRoot, "server.js")],
    outfile: serverFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    logLevel: "info",
  });
  const serverSource = await fs.readFile(serverFile, "utf8");
  const windowsSafeSource = serverSource.replace(
    "relativePath: path.relative(base, batch[j]),",
    'relativePath: path.relative(base, batch[j]).split(path.sep).join("/"),',
  );
  if (windowsSafeSource === serverSource) {
    throw new Error("Could not apply the Windows static asset path fix");
  }
  await fs.writeFile(serverFile, windowsSafeSource);
  await Promise.all([
    fs.cp(path.join(standaloneRoot, "dist"), path.join(outputRoot, "dist"), { recursive: true }),
    fs.cp(path.join(standaloneRoot, "public"), path.join(outputRoot, "public"), { recursive: true }),
  ]);
}

prepareDesktopServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
