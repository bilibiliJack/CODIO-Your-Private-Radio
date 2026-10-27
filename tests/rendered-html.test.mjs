import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the CODIO radio experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>CODIO - Private Radio<\/title>/i);
  assert.match(html, /TONIGHT&#x27;S RADIO/);
  assert.match(html, /YOUR DJ/);
  assert.match(html, /class="player-bar"/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("keeps history, status, and QQ authorization device-local", async () => {
  const [experience, styles, desktop, preload, seamless, lyrics] = await Promise.all([
    readFile(new URL("../app/RadioExperience.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../app/seamless-dj.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/LyricsScroller.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(experience, /codio-played-history/);
  assert.match(experience, /slice\(-5\)/);
  assert.match(experience, /role="status" aria-live="polite"/);
  assert.match(styles, /backdrop-filter:blur\(46px\) saturate\(185%\)/);
  assert.match(desktop, /persist:codio-qqmusic-login/);
  assert.match(desktop, /refreshQQPlaybackSession/);
  assert.match(desktop, /D:\\\\Codio-Data/);
  assert.match(seamless, /export type TrackAnalysis/);
  assert.match(seamless, /export function analyzePcmTrack/);
  assert.match(seamless, /export function planTransition/);
  assert.match(seamless, /export function getTransitionVisualFrame/);
  assert.match(experience, /new Worker\(new URL\("\.\/audio-analysis-worker\.ts"/);
  assert.match(experience, /scheduleDeckPlan/);
  assert.match(experience, /waitForTransitionAudioEnd/);
  assert.match(desktop, /codio:analysis-get/);
  assert.match(preload, /codio:analysis-save/);
  assert.match(styles, /One transparent glass material shared by the main and immersive players/);
  assert.match(desktop, /deepseek-v4-flash/);
  assert.match(desktop, /error\?\.code !== "EPIPE"/);
  assert.doesNotMatch(desktop, /ollama/i);
  assert.doesNotMatch(preload, /ollama/i);
  assert.match(preload, /codio:ai-step/);
  assert.match(preload, /codio:onboarding-get/);
  assert.match(desktop, /readDesktopOnboardingState/);
  assert.match(experience, /initialRecommendationRef/);
  assert.match(experience, /if \(activeQQTrack\) \{\s+await startQQTrack\(activeQQTrack\)/);
  assert.match(experience, /recoverCurrentTrack\(audio, trackKey\)/);
  assert.match(experience, /className="model-modal-body"/);
  assert.match(styles, /@media \(min-width:721px\) and \(max-width:900px\)[\s\S]*grid-template-columns:minmax\(230px,.76fr\) minmax\(0,1.74fr\)/);
  assert.match(styles, /@media \(min-width:901px\)[\s\S]*grid-template-columns:minmax\(250px,.86fr\) minmax\(420px,1.72fr\) minmax\(215px,.72fr\)/);
  assert.match(styles, /\.player-bar > \.transport,\.now-playing \.np-edge-bottom > \.transport \{\s+width:100%;\s+min-width:0;\s+justify-self:stretch;/);
  assert.match(styles, /\.atmosphere-lyrics \{[\s\S]*height:50%;[\s\S]*min-height:180px;/);
  assert.match(experience, /activeFeedbackScopes: activePreferences\(memory\)/);
  assert.match(experience, /import LyricsScroller from "\.\/LyricsScroller"/);
  assert.match(lyrics, /function LyricsScroller/);
  assert.equal((experience.match(/<LyricsScroller/g) || []).length, 2);
  assert.match(lyrics, /viewport\.scrollTo\(\{/);
  assert.match(lyrics, /export default memo\(LyricsScroller/);
  assert.doesNotMatch(styles, /@keyframes atmosphere-lyric-slide/);
  assert.match(styles, /both players share one control geometry/);
  assert.match(styles, /width:min\(100%,clamp\(500px,48vw,700px\)\)/);
  assert.match(styles, /grid-template-columns:minmax\(0,1fr\)/);
  for (const legacyPaymentText of [/BUY CREDITS/, /CODIO CLOUD/, /购买聊天额度/, /WECHAT PAY/, /billing:\s*["']credits["']/]) {
    assert.doesNotMatch(experience, legacyPaymentText);
    assert.doesNotMatch(styles, legacyPaymentText);
  }
  assert.match(experience, /CONNECT AI DJ/);
  assert.match(experience, /CONNECTED ON THIS DEVICE/);
  assert.match(desktop, /connectionMode:\s*"user_api_key"/);
  assert.match(experience, /className="onboarding-overlay"/);
  assert.match(experience, /setOnboardingStep\(1\)/);
  assert.match(experience, /setOnboardingQQSkipped\(true\)/);
  assert.match(experience, /setOnboardingDeepSeekSkipped\(true\)/);
  assert.match(experience, /onClick=\{reopenOnboarding\}/);
  assert.match(experience, /if \(onboardingFirstRun\)[\s\S]*audio\.pause\(\)[\s\S]*audio\.currentTime = 0/);
  assert.match(experience, /window\.codioDesktop\?\.onboarding/);
  assert.doesNotMatch(experience, /transitionTheme|DAY \/ NIGHT|className="mode-toggle"/);
  assert.doesNotMatch(experience, /ollama/i);
  assert.doesNotMatch(experience, /item\.title !== activeQQTrack\?\.title && !dislikedTitles\.has\(item\.title\)/);
  assert.match(experience, /codio-recommendation-pool-v1-/);
  // Seed balancing/admission is executed in recommendation-precision.test.mjs.
  // Last-reply truncation silently discarded earlier, often better sources.
  assert.doesNotMatch(experience, /entries\.values\(\)[^;\n]*slice\(-120\)/);
  assert.doesNotMatch(experience, /aria-label="随机播放"/);
  assert.match(experience, /analyseTrackWhenBuffered/);
  assert.match(experience, /DEEPSEEK V4 FLASH/);
  // Real recommendation/queue behavior is exercised in recommendation-visibility.test.mjs.
  assert.doesNotMatch(experience, /artistFeedbackWeights|learnedEnergyFit|nightFit/);
  assert.match(experience, /source\.startsWith\("data:"\)/);
  assert.match(desktop, /function qqArtistCover/);
  assert.match(desktop, /fallbackCover: qqArtistCover\(artistMid\)/);
  assert.match(experience, /async function resumeMusicAudioGraph/);
  assert.match(experience, /const audioGraphReady = await resumeMusicAudioGraph\(\)/);
  assert.match(experience, /data-title-size=\{atmosphereTitleSize\}/);
  assert.match(experience, /理解并控制你的电台/);
  assert.match(experience, /useState<LyricMode>\("cinematic"\)/);
  assert.match(experience, /recommendationTracks\[recommendationIdentity\(track\)\]/);
  // Candidate preparation is bounded per lane; its actual admission/failure
  // behavior is verified by recommendation-visibility.test.mjs, not this regex.
  assert.match(experience, /Array\.from\(\{ length: 4 \}, async \(\) =>/);
  assert.match(experience, /withTimeout\(prepareTrack\(track, false\), Math\.min\(6500, remaining\), "CANDIDATE_PLAYABILITY"\)/);
  assert.match(experience, /particleTransitionStartedAt/);
  assert.match(experience, /x \+= \(\(mouseX - x\)/);
  assert.doesNotMatch(experience, /x \+= \(\(x - mouseX\)/);
  assert.match(experience, /window\.innerWidth < 720 \? 180 : 192/);
  assert.match(experience, /const density = \.998 - Math\.pow\(edge, 1\.7\) \* \.25/);
  assert.match(experience, /const strideSize = gap \* Math\.sqrt\(particleStride\)/);
  assert.match(experience, /Math\.max\(1\.22, strideSize/);
  // Entry no longer paints a fabricated palette grid before the sampled cover.
  // First-frame/async behavior is exercised in particle-entry.test.mjs.
  assert.doesNotMatch(experience, /fallbackPointsCache = Array\.from/);
  assert.match(experience, /const cosRx = Math\.cos\(rx\)/);
  assert.match(experience, /distanceSquared < influenceRadiusSquared/);
  assert.doesNotMatch(experience, /pointerLift/);
  assert.match(experience, /const scatterStrength = \(transitionChoreography\?\.displacement \?\? \.08\)/);
  assert.match(experience, /const peakAt = \.46/);
  assert.match(experience, /const scatterEnvelope = transitionProgress < peakAt/);
  assert.match(experience, /transition\.from\.rgb\[0\].*point\.rgb\[0\].*morphEase/);
  assert.doesNotMatch(experience, /fromScatterX|toScatterX/);
  assert.match(experience, /spatiallyPairCoverPoints/);
  assert.doesNotMatch(experience, /from: coverPoints\[index % coverPoints\.length\]/);
  assert.match(experience, /context\.globalCompositeOperation = "source-over"/);
  assert.doesNotMatch(experience, /dustSize/);
  assert.match(experience, /120000 \/ Math\.max\(72, bpm\)/);
  assert.match(experience, /music\.visual\.dramaticEnvelope/);
  assert.match(seamless, /selectedDramatic\.length === 3/);
  assert.match(experience, /event\.code !== "Space"/);
  assert.doesNotMatch(experience, /input, textarea, select, button/);
  assert.doesNotMatch(styles, /@keyframes np-lyric-scroll/);
  assert.doesNotMatch(styles, /@keyframes np-lyric-in/);
  assert.match(experience, /className="recommendation-viewport"/);
  assert.match(experience, /playable\.slice\(0, 6\), playable\.slice\(6, 12\)/);
  assert.match(experience, /displayedWaveformRef/);
  assert.match(experience, /runtime \? \.055 : \.014/);
  assert.match(experience, /runtime\.outgoing\.currentTime/);
  assert.match(desktop, /refreshQQPlaybackSession\(true\)/);
  assert.doesNotMatch(experience, /const drawAurora|const drawOrbit|const drawSilk|const drawBloom/);
  assert.match(styles, /\.seamless-wave \{ width:33px; height:33px; flex:0 0 33px;/);
  assert.match(styles, /strong\[data-title-size="extra-long"\]/);
  assert.match(styles, /\.feature-visual \.atmosphere-lyrics \{ bottom:5\.5%; \}/);
  assert.match(styles, /\.recommendation-page \{ flex:0 0 100%;/);
  assert.match(styles, /grid-template-rows:repeat\(5,auto\)/);
  assert.match(styles, /data-lyrics-mode="minimal"/);
  assert.match(styles, /\.np-lyric\.cinematic[\s\S]*width:min\(86vw,1420px\)/);
  assert.match(experience, /releaseMusicAudio\(previousAudio\)/);
});
