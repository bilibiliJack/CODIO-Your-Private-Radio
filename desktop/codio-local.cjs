const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// First release deliberately supports PCM/IEEE-float WAV only. Unknown tags
// stay absent; filenames are fallback display titles, never artist evidence.
const SUPPORTED = ["wav"];
async function inspectWav(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const bytes = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    await handle.read(bytes, 0, bytes.length, 0);
    if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw Error("LOCAL_INVALID_WAV");
    let rate = 0, dataSize = 0, supported = false;
    const tags = {};
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
      if (start + size > stat.size) throw Error("LOCAL_TRUNCATED_WAV");
      if (type === "fmt " && size >= 16 && start + 16 <= bytes.length) {
        const format = bytes.readUInt16LE(start), channels = bytes.readUInt16LE(start + 2), bits = bytes.readUInt16LE(start + 14);
        rate = bytes.readUInt32LE(start + 8);
        const sampleRate = bytes.readUInt32LE(start + 4), align = bytes.readUInt16LE(start + 12);
        supported = (format === 1 && [8, 16, 24, 32].includes(bits) || format === 3 && bits === 32)
          && channels > 0 && channels <= 8 && sampleRate > 0 && rate === sampleRate * channels * bits / 8 && align === channels * bits / 8;
      }
      if (type === "data") { dataSize = size; break; }
      if (type === "LIST" && bytes.toString("ascii", start, start + 4) === "INFO") {
        for (let tag = start + 4; tag + 8 <= Math.min(start + size, bytes.length);) {
          const key = bytes.toString("ascii", tag, tag + 4), length = bytes.readUInt32LE(tag + 4), end = tag + 8 + length;
          if (end > bytes.length || end > start + size) break;
          if (["INAM", "IART", "IPRD"].includes(key)) tags[key] = bytes.toString("utf8", tag + 8, end).replace(/\0/g, "").trim().slice(0, 256);
          tag = end + length % 2;
        }
      }
      offset = start + size + size % 2;
    }
    if (!supported || !dataSize || !rate) throw Error("LOCAL_UNSUPPORTED_OR_EMPTY_WAV");
    const id = crypto.createHash("sha256").update(`${path.resolve(file).toLowerCase()}\0${stat.size}\0${stat.mtimeMs}`).digest("hex");
    return { file: path.resolve(file), size: stat.size, mtimeMs: stat.mtimeMs, track: {
      provider: "local", id, mid: id, title: tags.INAM || path.basename(file, path.extname(file)),
      artist: tags.IART || "Unknown artist", artistKnown: Boolean(tags.IART), ...(tags.IPRD ? { album: tags.IPRD } : {}),
      durationSeconds: dataSize / rate, metadataSource: tags.INAM || tags.IART ? "wav_info" : "filename_fallback",
    } };
  } finally { await handle.close(); }
}

function createLocalLibrary(storePath) {
  let registry;
  async function load() {
    if (!registry) {
      try { const saved = JSON.parse(await fs.readFile(storePath, "utf8")); registry = new Map(saved.entries.map(x => [x.track.mid, x])); }
      catch (error) { if (error.code !== "ENOENT") throw Error("LOCAL_LIBRARY_INVALID"); registry = new Map(); }
    }
    return registry;
  }
  async function list() { return [...(await load()).values()].map(x => x.track); }
  // Selection is provided ONLY by the main-process native dialog, not IPC paths.
  async function importSelected(selection) {
    const entries = await load();
    if (!selection?.length) return { ok: false, cancelled: true, imported: 0, duplicates: 0, failed: 0, tracks: await list(), supported: SUPPORTED };
    let scanned = 0, imported = 0, duplicates = 0, failed = 0, capped = false;
    const errors = [];
    async function visit(file, depth = 0) {
      if (scanned >= 2000 || entries.size >= 3000 || depth > 12) { capped = true; return; }
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) return; // never follow a selected directory out of scope
        if (stat.isDirectory()) { for (const child of await fs.readdir(file)) await visit(path.join(file, child), depth + 1); return; }
        if (!stat.isFile()) return;
        scanned++;
        if (path.extname(file).toLowerCase() !== ".wav") throw Error("LOCAL_FORMAT_UNSUPPORTED");
        const entry = await inspectWav(file);
        if (entries.has(entry.track.mid)) duplicates++;
        else { entries.set(entry.track.mid, entry); imported++; }
      } catch (error) { failed++; if (errors.length < 20) errors.push({ filename: path.basename(file), error: error.message }); }
    }
    for (const file of selection) await visit(file);
    if (imported) {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      const temporary = `${storePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: [...entries.values()] }));
      await fs.rename(temporary, storePath);
    }
    return { ok: imported + duplicates > 0, scanned, imported, duplicates, failed, capped, errors, supported: SUPPORTED, tracks: await list() };
  }
  async function resolve(id) {
    const entry = (await load()).get(String(id));
    if (!entry) throw Error("LOCAL_ID_NOT_IMPORTED");
    let stat;
    try { stat = await fs.stat(entry.file); } catch { throw Error("LOCAL_SOURCE_MISSING"); }
    if (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) throw Error("LOCAL_SOURCE_CHANGED");
    return entry.file;
  }
  return { list, importSelected, resolve };
}

async function serveLocalFile(file, request, response) {
  const stat = await fs.stat(file);
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
  if (start >= stat.size || end < start) { response.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); response.end(); return; }
  const headers = { "Content-Type": "audio/wav", "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "private, max-age=120" };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") { response.end(); return; }
  const stream = fsSync.createReadStream(file, { start, end });
  stream.on("error", () => response.destroy()); response.on("close", () => stream.destroy()); stream.pipe(response);
}
module.exports = { createLocalLibrary, inspectWav, serveLocalFile };
