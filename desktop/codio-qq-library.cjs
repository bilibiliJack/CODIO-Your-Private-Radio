const fs = require("node:fs/promises");
const path = require("node:path");
// The provider's explicit boolean/type wins. A renameable title is only a
// weak hint; do not assert that it is QQ's official favorites folder.
function likedEvidence(item) {
  if (item.is_liked === true || item.type === "liked") return { source: "provider_playlist_type", confidence: 1, confirmed: true };
  if (/我喜欢|喜欢的音乐|liked|favorite/i.test(item.name || "")) return { source: "playlist_name_hint", confidence: .3, confirmed: false };
  return { source: "unknown", confidence: 0, confirmed: false };
}

async function confirmFavoritePlaylist(cacheFile, playlistId, confirmedAt = Date.now()) {
  const snapshot = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  if (!Array.isArray(snapshot.playlists) || !Array.isArray(snapshot.tracks)
    || snapshot.playlists.filter(playlist => playlist.id === playlistId).length !== 1) throw Error("QQ_PLAYLIST_CONFIRMATION_INVALID");
  const evidence = { source: "user_confirmation", confidence: .95, confirmed: true, confirmedAt };
  const playlists = snapshot.playlists.map(playlist => playlist.id === playlistId ? { ...playlist, likedEvidence: evidence } : playlist);
  const tracks = snapshot.tracks.map(track => track.playlistMembership?.some(playlist => playlist.id === playlistId)
    ? { ...track, likedInProvider: true, likedEvidence: evidence } : track);
  const artists = new Map();
  for (const track of tracks) for (const artist of String(track.artist || "").split(" / ").filter(Boolean))
    artists.set(artist, (artists.get(artist) || 0) + (track.likedInProvider ? 2.4 : 1));
  const result = { ...snapshot, playlists, tracks, likedCount: tracks.filter(track => track.likedInProvider).length,
    topArtists: [...artists].sort((a,b) => b[1]-a[1]).slice(0,30).map(([name,weight]) => ({ name, weight })) };
  const temporary = `${cacheFile}.${process.pid}.confirmation.tmp`;
  await fs.writeFile(temporary, JSON.stringify(result)); await fs.rename(temporary, cacheFile);
  return { trackCount: tracks.length, likedCount: result.likedCount, source: evidence.source };
}
async function readLibrarySnapshot({ request, mapTrack, cacheFile, force = false, ttlMs = 10 * 60 * 1000, now = Date.now }) {
  let previous = { playlists: [], tracks: [] };
  try {
    previous = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (!Array.isArray(previous.playlists) || !Array.isArray(previous.tracks)) throw Error("QQ_LIBRARY_CACHE_INVALID");
  } catch (error) { if (error.code !== "ENOENT") throw Error("QQ_LIBRARY_CACHE_INVALID"); }
  const syncedAt = previous.coverage?.syncedAt;
  const ageMs = now() - syncedAt;
  if (force !== true && Number.isFinite(syncedAt) && ageMs >= 0 && ageMs < ttlMs
      && previous.coverage.listComplete === true && previous.coverage.partial === false) {
    return { ...previous, cache: { source: "snapshot", ageMs, ttlMs } };
  }
  const playlists = [], seen = new Set();
  let listComplete = false, declaredCount = null, listFailed = false;
  for (let page = 0; page < 5 && playlists.length < 120; page++) {
    try {
      const data = await request("list", { offset: page * 100, size: 100 });
      if (data.code !== undefined && data.code !== 0) throw Error("QQ_LIBRARY_PROVIDER_ERROR");
      const raw = data?.data?.disslist || data?.disslist;
      if (!Array.isArray(raw)) throw Error("QQ_LIBRARY_LIST_INVALID");
      const total = data?.data?.total ?? data?.data?.totalnum;
      if (Number.isFinite(Number(total)) && total !== undefined) declaredCount = Number(total);
      for (const item of raw) {
        const id = String(item.tid || item.dissid || item.id || "");
        if (!id || seen.has(id) || playlists.length >= 120) continue;
        seen.add(id);
        const playlist = { id, name: String(item.diss_name || item.dissname || item.name || "Untitled playlist"),
          declaredTrackCount: Math.max(0, Number(item.song_cnt || item.songnum || item.song_count || 0)), type: item.type, is_liked: item.is_liked };
        const confirmed = previous.playlists.find(saved => saved.id === id)?.likedEvidence;
        playlist.likedEvidence = confirmed?.source === "user_confirmation" && confirmed.confirmed === true ? confirmed : likedEvidence(playlist);
        playlists.push(playlist);
      }
      if (raw.length < 100 || declaredCount !== null && seen.size >= declaredCount) { listComplete = true; break; }
    } catch { listFailed = true; break; }
  }
  if (listFailed && !playlists.length && !previous.tracks.length) throw Error("QQ_LIBRARY_LIST_UNAVAILABLE");
  const details = []; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, playlists.length) }, async () => {
    while (cursor < playlists.length) {
      const playlist = playlists[cursor++];
      try {
        const data = await request("detail", { id: playlist.id });
        if (data.code !== undefined && data.code !== 0) throw Error("QQ_LIBRARY_PROVIDER_ERROR");
        const detail = data?.cdlist?.[0] || data?.data?.cdlist?.[0];
        const raw = detail?.songlist || detail?.song_list;
        if (!Array.isArray(raw)) throw Error("QQ_LIBRARY_TRACKS_INVALID");
        const count = Number(detail.total_song_num || detail.songnum || playlist.declaredTrackCount || raw.length);
        let tracks = raw.slice(0, 1000).map(mapTrack).filter(x => x.mid && x.title);
        const complete = raw.length <= 1000 && tracks.length >= count;
        const readTrackCount = tracks.length;
        if (!complete) tracks = [...new Map([...previous.tracks.filter(x => x.playlistMembership?.some(p => p.id === playlist.id)), ...tracks].map(x => [x.mid, x])).values()];
        details.push({ ...playlist, name: String(detail.dissname || playlist.name), trackCount: tracks.length, readTrackCount, complete, retained: tracks.length > readTrackCount, tracks });
      } catch {
        const old = previous.playlists.find(x => x.id === playlist.id);
        const tracks = previous.tracks.filter(x => x.playlistMembership?.some(p => p.id === playlist.id));
        details.push({ ...playlist, trackCount: tracks.length, complete: false, retained: true, error: "QQ_PLAYLIST_UNAVAILABLE", tracks, likedEvidence: old?.likedEvidence || playlist.likedEvidence });
      }
    }
  }));
  if (!listComplete) for (const old of previous.playlists) if (!seen.has(old.id)) {
    details.push({ ...old, retained: true, complete: false, tracks: previous.tracks.filter(x => x.playlistMembership?.some(p => p.id === old.id)) });
  }
  const tracks = new Map(), artists = new Map();
  for (const playlist of details) for (const track of playlist.tracks) {
    const prior = tracks.get(track.mid);
    if (!prior && tracks.size >= 3000) continue;
    const relations = [...(prior?.playlistMembership || []), { id: playlist.id, name: playlist.name }];
    tracks.set(track.mid, { ...track, playlistMembership: [...new Map(relations.map(p => [p.id, p])).values()],
      likedInProvider: prior?.likedInProvider || playlist.likedEvidence?.confirmed || false,
      likedEvidence: prior?.likedEvidence?.confidence > playlist.likedEvidence?.confidence ? prior.likedEvidence : playlist.likedEvidence });
  }
  for (const track of tracks.values()) for (const artist of String(track.artist || "").split(" / ").filter(Boolean)) {
    artists.set(artist, (artists.get(artist) || 0) + (track.likedInProvider ? 2.4 : 1));
  }
  const snapshot = { playlists: details.map(playlist => { const item = { ...playlist }; delete item.tracks; return item; }), tracks: [...tracks.values()],
    playlistNames: details.map(p => p.name), likedCount: [...tracks.values()].filter(x => x.likedInProvider).length,
    topArtists: [...artists].sort((a,b) => b[1]-a[1]).slice(0,30).map(([name,weight]) => ({ name, weight })),
    coverage: { listComplete, declaredPlaylistCount: declaredCount, readPlaylistCount: playlists.length,
      completePlaylists: details.filter(p => p.complete && !p.retained).length, retainedPlaylists: details.filter(p => p.retained).length,
      partial: !listComplete || details.some(p => !p.complete) || tracks.size >= 3000,
      playlistLimit: 120, tracksPerPlaylistLimit: 1000, uniqueTrackLimit: 3000, syncedAt: now() } };
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const temp = `${cacheFile}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(snapshot)); await fs.rename(temp, cacheFile);
  return { ...snapshot, cache: { source: "provider", ageMs: 0, ttlMs } };
}
module.exports = { readLibrarySnapshot, likedEvidence, confirmFavoritePlaylist };
