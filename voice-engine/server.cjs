const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const sherpa = require("sherpa-onnx-node");

const ROOT = path.resolve(__dirname, "models");
const PORT = Number(process.env.CODIO_VOICE_PORT || 7788);
const cache = new Map();
const engines = new Map();

const VOICES = {
  yanchuan: {
    zh: { sid: 10, speed: 0.91 },
    en: { sid: 1, speed: 0.94 },
  },
  zhixia: {
    zh: { sid: 4, speed: 0.94 },
    en: { sid: 0, speed: 0.97 },
  },
};

function engineFor(language) {
  if (engines.has(language)) return engines.get(language);

  let config;
  if (language === "zh") {
    const modelDir = path.join(ROOT, "vits-icefall-zh-aishell3");
    config = {
      model: {
        vits: {
          model: path.join(modelDir, "model.onnx"),
          lexicon: path.join(modelDir, "lexicon.txt"),
          tokens: path.join(modelDir, "tokens.txt"),
        },
      },
      ruleFsts: ["phone.fst", "date.fst", "number.fst", "new_heteronym.fst"]
        .map((name) => path.join(modelDir, name))
        .join(","),
      ruleFars: path.join(modelDir, "rule.far"),
      maxNumSentences: 2,
      numThreads: 4,
      provider: "cpu",
    };
  } else {
    const modelDir = path.join(ROOT, "vits-vctk");
    config = {
      model: {
        vits: {
          model: path.join(modelDir, "vits-vctk.int8.onnx"),
          lexicon: path.join(modelDir, "lexicon.txt"),
          tokens: path.join(modelDir, "tokens.txt"),
        },
      },
      maxNumSentences: 2,
      numThreads: 4,
      provider: "cpu",
    };
  }

  const engine = new sherpa.OfflineTts(config);
  engines.set(language, engine);
  return engine;
}

function wavBuffer(samples, sampleRate) {
  const dataLength = samples.length * 2;
  const output = Buffer.alloc(44 + dataLength);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataLength, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    output.writeInt16LE(value < 0 ? value * 32768 : value * 32767, 44 + index * 2);
  }
  return output;
}

function allowedOrigin(request) {
  const origin = request.headers.origin || "";
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? origin : "http://localhost:3000";
}

function sendJson(response, status, body, origin) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  const origin = allowedOrigin(request);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      status: "ready",
      engine: "sherpa-onnx",
      languages: ["zh", "en"],
      voices: Object.keys(VOICES),
    }, origin);
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/tts") {
    sendJson(response, 404, { error: "Not found" }, origin);
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const text = String(payload.text || "").trim().slice(0, 420);
    const voice = VOICES[payload.voice] ? payload.voice : "zhixia";
    const language = payload.language === "en" || payload.language === "zh"
      ? payload.language
      : /[\u3400-\u9fff]/.test(text) ? "zh" : "en";

    if (!text) {
      sendJson(response, 400, { error: "Text is required" }, origin);
      return;
    }

    const profile = VOICES[voice][language];
    const key = crypto.createHash("sha1").update(`${voice}:${language}:${text}`).digest("hex");
    let audio = cache.get(key);
    if (!audio) {
      const tts = engineFor(language);
      const result = tts.generate({
        text,
        sid: profile.sid,
        speed: profile.speed,
      });
      audio = wavBuffer(result.samples, result.sampleRate);
      cache.set(key, audio);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
    }

    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": audio.length,
      "Cache-Control": "private, max-age=86400",
      "Access-Control-Allow-Origin": origin,
      "X-Codio-Voice": voice,
      "X-Codio-Language": language,
    });
    response.end(audio);
  } catch (error) {
    console.error("[CODIO voice]", error);
    sendJson(response, 500, { error: "Voice generation failed" }, origin);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[CODIO voice] listening on http://127.0.0.1:${PORT}`);
  console.log("[CODIO voice] local-only · Chinese/English · male/female");
});
