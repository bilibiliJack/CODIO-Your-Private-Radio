import {
  activePreferences,
  deriveListeningProfile,
  implicitSignalStrength,
  isEffectiveListening,
  isLearningEvent,
  listeningStatus,
  RECENT_WINDOW_MS,
  type DerivedListeningProfile,
  type ListeningMemory,
  type PlaySettledEvent,
  type PreferenceChangedEvent,
} from "./listening-intelligence";

type PresentationOptions = {
  now?: number;
  recommendationUpdate?: Record<string, unknown>;
};

const normalize = (value: string) => value.trim().toLocaleLowerCase();
const preferenceKey = (event: PreferenceChangedEvent) => `${event.targetType}:${event.targetType === "track" ? event.targetKey : normalize(event.targetKey)}`;
const playSources: Record<PlaySettledEvent["source"], string> = {
  recommendation_match: "贴合推荐", recommendation_frontier: "探索推荐", search: "搜索", library: "音乐库", queue: "播放队列", manual: "手动播放",
};

function recommendationPresentation(update: Record<string, unknown> | undefined, lastLearningAt: number) {
  if (!update?.status) return { status: "unconfirmed", label: "等待推荐更新", detail: "反馈记录与推荐提交是两件事；目前没有本轮更新结果。" };
  const lanes = Array.isArray(update.lanes) ? update.lanes.filter((lane): lane is Record<string, unknown> => Boolean(lane && typeof lane === "object")) : [];
  const versions = [update.profileVersion, ...lanes.filter(lane => lane.status === "completed").map(lane => lane.profileVersion)].filter((value): value is number => typeof value === "number");
  const status = update.status === "completed" && versions.length && !versions.some(version => version >= lastLearningAt) ? "superseded" : String(update.status);
  if (["queued", "pending", "running"].includes(status)) return { status, label: "正在重排后续候选", detail: "本轮候选正在重排；尚未确认新的队列提交。" };
  if (status === "completed") return { status, label: update.hiddenQueueCommitted === true ? "后续队列已更新" : "候选重排已完成",
    detail: `${update.hiddenQueueCommitted === true ? "已有后续播放队列提交记录。" : "没有已提交后续播放队列更新的记录。"}${update.visibleBatchPreserved === true ? "当前展示的歌曲保持不变。" : ""}${versions.length ? "" : "结果未记录证据版本，无法确认是否已覆盖最新反馈。"}` };
  if (status === "superseded") return { status, label: "等待最新反馈重排", detail: "这轮结果不是最新反馈的提交结果。" };
  if (status === "failed") return { status, label: "推荐更新未完成", detail: "反馈仍然有效；本轮推荐更新失败，未确认新的队列提交。" };
  return { status, label: "保留当前歌曲", detail: "本轮没有足够可靠的候选，未确认新的队列提交。" };
}

/** Present the existing evidence; this does not learn, persist, or rank anything. */
export function buildListeningPresentation(memory: ListeningMemory, profile?: DerivedListeningProfile, options: PresentationOptions = {}) {
  const now = options.now ?? Date.now();
  const derived = profile ?? deriveListeningProfile(memory, now);
  const active = activePreferences(memory, now);
  const activeIds = new Set(active.map(event => event.eventId));
  const latest = new Map<string, PreferenceChangedEvent>();
  for (const event of memory.explicitPreferences) {
    const key = preferenceKey(event), previous = latest.get(key);
    if (!previous || event.createdAt >= previous.createdAt) latest.set(key, event);
  }
  const settlements = memory.rawEvents.filter((event): event is PlaySettledEvent => event.type === "play_settled" && event.exitReason !== "error");
  const feedback = [...memory.explicitPreferences].sort((a, b) => b.createdAt - a.createdAt).map(event => {
    const current = latest.get(preferenceKey(event));
    const state = activeIds.has(event.eventId) ? "active" : event.value === "neutral" || current?.value === "neutral" ? "withdrawn" : current?.eventId !== event.eventId ? "superseded" : "expired";
    const track = event.targetType === "track" ? memory.trackMemories[event.targetKey] : undefined;
    const play = event.targetType === "track" ? settlements.findLast(item => item.trackKey === event.targetKey) : undefined;
    return { eventId: event.eventId, targetKey: event.targetKey, targetType: event.targetType,
      title: event.title || track?.title || play?.title || (event.targetType === "track" ? event.targetKey : event.targetType === "artist" ? `歌手 ${event.targetKey}` : event.targetKey),
      artist: event.artist || track?.artist || play?.artist || event.features?.artist || (event.targetType === "artist" ? event.targetKey : ""),
      sourceLabel: event.reason === "recommendation_card" ? "推荐卡片" : event.source === "dj" ? "CODIO DJ 明确记录" : event.source === "player" ? "播放栏反馈" : event.source === "legacy" ? "迁移的历史反馈" : "明确反馈（来源未记录）",
      actionLabel: event.value === "more" ? "多听一点" : event.value === "less" ? "少听一点" : "撤回偏好",
      createdAt: event.createdAt, state, active: activeIds.has(event.eventId), latest: current?.eventId === event.eventId,
      scopeLabel: event.scope === "session" ? "仅这次会话" : "长期偏好" };
  });
  const trackKeys = new Set([...Object.keys(memory.trackMemories), ...settlements.map(event => event.trackKey)]);
  const statuses = [...trackKeys].map(key => listeningStatus(memory, key, now));
  const stats = {
    effectiveListens: statuses.reduce((count, status) => count + status.effectivePlays, 0),
    effectiveTracks: statuses.filter(status => status.effective).length,
    settledPlays: Object.values(memory.trackMemories).reduce((count, track) => count + (track.settledPlayCount || 0), 0),
    completedListens: Object.values(memory.trackMemories).reduce((count, track) => count + (track.completionCount || 0), 0),
    activeLikes: active.filter(event => event.targetType === "track" && event.value === "more").length,
    activeDislikes: active.filter(event => event.targetType === "track" && event.value === "less").length,
    activeFeedback: active.length,
    earlySkips: settlements.filter(event => implicitSignalStrength(event) < 0).length,
    retainedSettlements: settlements.length,
    legacyUncertainTracks: [...trackKeys].filter((key, index) => statuses[index].legacyUncertain || memory.trackMemories[key]?.effectivePlayCount === undefined
      && (memory.trackMemories[key]?.settledPlayCount || 0) > settlements.filter(event => event.trackKey === key).length).length,
  };
  const artistNames = new Map<string, string>();
  Object.values(memory.trackMemories).forEach(track => { if (track.artist) artistNames.set(normalize(track.artist), track.artist); });
  settlements.forEach(event => { if (event.artist) artistNames.set(normalize(event.artist), event.artist); });
  active.filter(event => event.targetType === "artist").forEach(event => artistNames.set(normalize(event.targetKey), event.artist || event.targetKey));
  const artists = (affinities: Record<string, number>) => Object.entries(affinities).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([key, score]) => ({ name: artistNames.get(key) || key, score }));
  const lifetimeArtists = artists(derived.lifetimeProfile.artistAffinities), recentArtists = artists(derived.recentProfile.artistAffinities);
  const comparisonReady = derived.confidence !== "insufficient" && derived.recentProfile.distinctTrackCount >= 3 && lifetimeArtists.length > 0 && recentArtists.length > 0;
  const artistComparison = !comparisonReady
    ? { status: "insufficient", summary: "近期与长期还没有足够独立的收听证据，暂不判断方向是否改变。" }
    : normalize(lifetimeArtists[0].name) === normalize(recentArtists[0].name)
      ? { status: "aligned", summary: `近期与长期的最强歌手线索都指向 ${lifetimeArtists[0].name}；这不等于其所有作品都有相同声音。` }
      : { status: "different", summary: `近期最强的歌手线索是 ${recentArtists[0].name}，长期最强线索是 ${lifetimeArtists[0].name}；这是两个证据层的差异，不是固定人格。` };
  const newestSettlements = [...settlements].sort((a, b) => b.settledAt - a.settledAt);
  const recentListening = newestSettlements.slice(0, 8).map(event => ({
    eventId: event.eventId, trackKey: event.trackKey, title: event.title, artist: event.artist, sourceLabel: playSources[event.source] || "来源未记录",
    settledAt: event.settledAt, listenedSeconds: event.listenedSeconds, effective: isEffectiveListening(event),
    outcomeLabel: !isEffectiveListening(event) ? implicitSignalStrength(event) < 0 ? "较早切换 · 仅弱负反馈" : "短暂播放 · 不计有效收听"
      : event.completionRatio >= .8 ? "听过至少 80%" : "有效收听",
  }));
  const recentChange = feedback.find(event => event.createdAt >= now - RECENT_WINDOW_MS && (event.active || event.state === "withdrawn" && event.latest));
  const recentListen = newestSettlements.find(event => isEffectiveListening(event) && event.settledAt >= now - RECENT_WINDOW_MS);
  const summaryEvidence: Array<{ at: number; text: string; kind: "feedback" | "listen" | "correction" | "intent" }> = [];
  if (recentChange) summaryEvidence.push({ at: recentChange.createdAt, kind: "feedback", text: recentChange.state === "withdrawn" ? `已撤回「${recentChange.title}」的明确偏好；这条反馈不再生效。`
    : `${recentChange.actionLabel}「${recentChange.title}」${recentChange.artist && recentChange.targetType === "track" ? ` · ${recentChange.artist}` : ""}，已记为${recentChange.scopeLabel}。` });
  if (recentListen) summaryEvidence.push({ at: recentListen.settledAt, kind: "listen", text: `最近有效听过「${recentListen.title}」${recentListen.artist ? ` · ${recentListen.artist}` : ""}；这是收听证据，不等于明确喜欢。` });
  const correction = [...memory.corrections].sort((a, b) => b.createdAt - a.createdAt).find(event => event.createdAt >= now - RECENT_WINDOW_MS);
  if (correction) summaryEvidence.push({ at: correction.createdAt, kind: "correction", text: `你将一条画像判断标记为「${({ confirm: "准确", reject: "不太对", "session-only": "只适合这次会话", "ignore-behavior": "不要用这条行为推断" })[correction.verdict]}」；这是你的纠正，不是新测得的声音结论。` });
  if (derived.sessionIntent) {
    const intent = derived.sessionIntent;
    summaryEvidence.push({ at: intent.createdAt, kind: "intent", text: `本次会话想听${({ familiar: "熟悉的音乐", balanced: "熟悉与新歌平衡", explore: "更多新方向" })[intent.familiarity]}、${({ calm: "平静一点", balanced: "能量平衡", energetic: "更有活力" })[intent.energy]}、${({ continuous: "连续衔接", balanced: "走向平衡", varied: "多些变化" })[intent.flow]}；这是会过期的会话选择，不代表声音特征已测得。` });
  }
  const summary = summaryEvidence.sort((a, b) => b.at - a.at)[0]?.text
    || (lifetimeArtists[0] ? `现有证据里，${lifetimeArtists[0].name} 是一个歌手线索；下一条反馈仍然可以改变它。`
      : stats.effectiveListens || stats.activeFeedback ? `已有 ${stats.effectiveListens} 次有效收听、${stats.activeFeedback} 条有效明确反馈；还不足以推断声音偏好。`
        : "先听几首，或点一次喜欢／少听。CODIO 会从真实收听和明确反馈里逐渐理解你的选择。");
  let companionLine = "先按自己的节奏听。遇到想留下的歌，或想少听的歌，都可以告诉我。";
  const newestKind = summaryEvidence[0]?.kind;
  const preferenceLine = (event: typeof feedback[number]) => event.state === "withdrawn" ? `「${event.title}」之前的反馈撤回了。先不替你定下来，想法变了也没关系。`
    : event.actionLabel === "少听一点" ? `你想少听一点「${event.title}」，我记得。${event.targetType === "track" ? "说的是这一首，先不替你猜别的。" : "喜好不用勉强，随时可以换个想法。"}`
      : `你想多听一点「${event.title}」，我记得。${event.scopeLabel === "仅这次会话" ? "这个想法，就留给这次听歌。" : "遇到喜欢的歌，就让它多陪你一会儿。"}`;
  if (newestKind === "feedback" && recentChange) companionLine = preferenceLine(recentChange);
  else if (newestKind === "intent" && derived.sessionIntent) {
    const intent = derived.sessionIntent;
    const wishes = [({ familiar: "在熟悉的歌里待一会儿", balanced: "熟悉的歌和新方向都留一点", explore: "往新方向走走" })[intent.familiarity]];
    if (intent.energy !== "balanced") wishes.push(intent.energy === "calm" ? "平静一点" : "有活力一点");
    if (intent.flow !== "balanced") wishes.push(intent.flow === "continuous" ? "衔接顺一点" : "多一些变化");
    companionLine = `今晚想${wishes.join("、")}，知道了。这个想法，只留给这次听歌。`;
  } else if (newestKind === "correction" && correction) companionLine = ({
    confirm: "这个方向，你点头了，我记得。认识你的喜好，还是得听你说。",
    reject: "刚才那句没说对，知道了。你的喜好，还是你来定义。",
    "session-only": "这个方向只留给今晚，知道了。以后想换，也不用解释。",
    "ignore-behavior": "这一次先不拿来猜你。想怎么听，你说了算。",
  })[correction.verdict];
  else if (recentListen) {
    const trackFeedback = feedback.find(event => event.active && event.targetType === "track" && event.targetKey === recentListen.trackKey);
    const positiveListens = newestSettlements.filter(event => event.settledAt >= now - RECENT_WINDOW_MS && isEffectiveListening(event) && event.completionRatio >= .8);
    const lifetimeArtist = lifetimeArtists[0], recentArtist = recentArtists[0];
    const artistPlays = (artist: string) => positiveListens.filter(event => normalize(event.artist) === normalize(artist));
    const sustainedArtist = artistPlays(recentListen.artist);
    const oldArtistCount = lifetimeArtist ? [...trackKeys].reduce((count, key, index) => count + (normalize(memory.trackMemories[key]?.artist || newestSettlements.find(event => event.trackKey === key)?.artist || "") === normalize(lifetimeArtist.name)
      ? statuses[index].effectivePlays : 0), 0) : 0;
    const repeated = (memory.trackMemories[recentListen.trackKey]?.effectivePlayCount || 0) >= 2
      || newestSettlements.filter(event => event.trackKey === recentListen.trackKey && isEffectiveListening(event)).length >= 2;
    if (trackFeedback?.actionLabel === "少听一点") companionLine = preferenceLine(trackFeedback);
    else if (repeated) companionLine = `「${recentListen.title}」，你已经听过不止一次了。熟悉的歌，也可以不用急着换。`;
    else if (artistComparison.status === "different" && lifetimeArtist && recentArtist && oldArtistCount >= 3 && artistPlays(recentArtist.name).length >= 3)
      companionLine = `常听的 ${lifetimeArtist.name} 之外，这阵子也常出现 ${recentArtist.name}。听歌的方向，可以慢慢长出新的一边。`;
    else if (derived.confidence !== "insufficient") {
      const genre = Object.entries(derived.recentProfile.tagAffinities).filter(([tag, score]) => tag.startsWith("genre:") && score > 0
        && !active.some(event => event.targetType === "feature" && normalize(event.targetKey) === tag && event.value === "less")).sort((a, b) => b[1] - a[1]).find(([tag]) =>
        new Set(positiveListens.filter(event => event.features?.tags.some(feature => feature.value && normalize(feature.value) === tag && feature.source === "provider_metadata" && feature.profileEligible && feature.confidence >= .45)).map(event => event.trackKey)).size >= 3);
      if (genre) companionLine = `最近的几首 ${genre[0].slice(6)}，你都听了大半。要不要聊聊，哪首最留得住你？`;
      else if (recentListen.artist && (derived.recentProfile.artistAffinities[normalize(recentListen.artist)] || 0) > 0 && sustainedArtist.length >= 3 && new Set(sustainedArtist.map(event => event.trackKey)).size >= 2)
        companionLine = `这阵子，${recentListen.artist} 的几首歌，你都听了大半。我们可以从这些常听的歌聊起。`;
    }
    if (companionLine.startsWith("先按自己的节奏听") && recentListen.completionRatio >= .8) companionLine = "这一首，你听了大半。先按自己的节奏听，不急着给喜好起名字。";
  }
  const lastEvidenceAt = [
    ...settlements.filter(event => isEffectiveListening(event) || implicitSignalStrength(event) !== 0).map(event => event.settledAt),
    ...memory.explicitPreferences.map(event => event.createdAt), ...memory.corrections.map(event => event.createdAt),
    ...Object.values(memory.longTermAggregates).map(value => value.lastSeenAt),
    ...Object.values(memory.trackMemories).filter(track => (track.effectivePlayCount || 0) > 0).map(track => track.lastEffectiveAt || track.lastSeenAt),
    ...memory.rawEvents.filter(event => event.type === "session_intent_changed").map(event => event.createdAt),
    ...(memory.sessionIntent ? [memory.sessionIntent.createdAt] : [])].reduce((latest, at) => Math.max(latest, at), 0);
  const lastLearningAt = [
    ...memory.rawEvents.filter(isLearningEvent).map(event => event.type === "play_settled" ? event.settledAt : event.createdAt),
    ...memory.explicitPreferences.map(event => event.createdAt), ...memory.corrections.map(event => event.createdAt),
    ...Object.values(memory.longTermAggregates).map(value => value.lastSeenAt),
    ...(memory.sessionIntent ? [memory.sessionIntent.createdAt] : [])].reduce((latest, at) => Math.max(latest, at), 0);
  const limitations = ["歌单导入不等于实际听过；播放错误不计入有效收听。", "喜欢按当前有效的歌曲反馈计数；撤回、替换和过期的会话反馈不再计入。", "早切数量只统计仍留存的结算记录，不是完整历史的跳过总数。"];
  if (stats.legacyUncertainTracks) limitations.push(`${stats.legacyUncertainTracks} 首旧记录缺少有效收听明细；有效收听次数只显示可确认的部分。`);
  if (!Object.values(derived.lifetimeProfile.tagAffinities).some(value => value > 0)) limitations.push("目前没有足够可靠的歌曲特征，不推断音色、情绪或人格。");
  return { summary, companionLine, confidenceLabel: derived.confidence === "reliable" ? "RELIABLE" : derived.confidence === "growing" ? "GROWING" : "STILL LEARNING",
    lastEvidenceAt, stats, recentFeedback: feedback.slice(0, 8), recentListening, lifetimeArtists, recentArtists, artistComparison,
    recommendation: recommendationPresentation(options.recommendationUpdate, lastLearningAt), limitations };
}
