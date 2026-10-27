/// <reference lib="webworker" />

import { analyzePcmTrack } from "./seamless-dj";

type AnalyzeRequest = {
  id: string;
  trackId: string;
  sampleRate: number;
  channels: ArrayBuffer[];
  sourceSignature?: string;
};

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { id, trackId, sampleRate, channels, sourceSignature } = event.data;
  try {
    const analysis = analyzePcmTrack({ trackId, sampleRate, channels: channels.map((channel) => new Float32Array(channel)), sourceSignature });
    self.postMessage({ id, analysis });
  } catch (error) {
    self.postMessage({ id, analysis: null, error: error instanceof Error ? error.message : "ANALYSIS_FAILED" });
  }
};

export {};
