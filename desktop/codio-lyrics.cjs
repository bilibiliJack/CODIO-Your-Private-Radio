const { inflateSync } = require("node:zlib");

// Table-driven QQ QRC compatibility, not an encryption API or user secret.
// The wire format uses little-endian 32-bit words, nonstandard S-box entries
// and a PC-2 right-half offset of 27. No third-party runtime is required.
const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,15,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,10,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];
const bit = (bytes, position) => (bytes[(position - 1 >>> 3) ^ 3] >>> (7 - (position - 1 & 7))) & 1;
const word = (values) => values.reduce((result,value) => (result << 1 | value) >>> 0, 0);
const keys = Buffer.from("!@#)(*$%123ZXC!@!@#)(NHL");
const schedules = [16,8,0].map((offset,index) => {
  const key = keys.subarray(offset,offset+8), bits = PC1.map(position => bit(key,position));
  let c = word(bits.slice(0,28)), d = word(bits.slice(28));
  const rounds = SHIFTS.map(shift => {
    c = (c << shift | c >>> (28-shift)) & 0xfffffff;
    d = (d << shift | d >>> (28-shift)) & 0xfffffff;
    return Array.from({length:8},(_,box) => word(PC2.slice(box*6,box*6+6).map(position => {
      if(position <= 28) return c >>> (28-position) & 1;
      const shift = 55-position; return shift < 0 ? 0 : d >>> shift & 1;
    })));
  });
  return index === 1 ? rounds : rounds.reverse();
});

function decryptQRC(value) {
  if(typeof value !== "string" || !/^[0-9a-f]+$/i.test(value) || value.length % 16 || value.length > 128*1024) throw Error("QQ_LYRICS_INVALID_QRC");
  const input = Buffer.from(value,"hex"), output = Buffer.alloc(input.length);
  for(let offset=0;offset<input.length;offset+=8) {
    let bytes = input.subarray(offset,offset+8);
    for(const rounds of schedules) {
      const bits = IP.map(position => bit(bytes,position));
      let left = word(bits.slice(0,32)), right = word(bits.slice(32));
      for(const key of rounds) {
        let substituted = 0;
        for(let box=0;box<8;box++) {
          const expanded = box===0 ? (right & 1)<<5 | right>>>27 : box===7 ? (right & 31)<<1 | right>>>31 : right >>> (27-box*4) & 63;
          const value = expanded ^ key[box], row = (value & 32)>>>4 | value & 1;
          substituted = substituted << 4 | S[box][row*16 + (value>>>1 & 15)];
        }
        const f = word(P.map(position => substituted >>> (32-position) & 1));
        [left,right] = [right,(left ^ f) >>> 0];
      }
      const next = Buffer.alloc(8);
      IP.forEach((position,index) => {
        const value = (index<32 ? right >>> (31-index) : left >>> (63-index)) & 1;
        next[(position-1 >>> 3)^3] |= value << (7-(position-1 & 7));
      });
      bytes = next;
    }
    bytes.copy(output,offset);
  }
  return inflateSync(output,{maxOutputLength:512*1024}).toString("utf8");
}

function lyricEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt);/gi, (match,entity) => {
    if(entity[0] !== "#") return {amp:"&",apos:"'",quot:'"',lt:"<",gt:">"}[entity.toLowerCase()];
    const code = entity[1].toLowerCase()==="x" ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

function parseQQLyrics(raw) {
  if(typeof raw !== "string" || raw.length > 512*1024) throw Error("QQ_LYRICS_INVALID_FORMAT");
  // QQ sometimes leaves literal quotation marks inside LyricContent. Its
  // attribute ends at the element terminator, not at a quoted sung phrase.
  const attributes = [...raw.matchAll(/\bLyricContent\s*=\s*"([\s\S]*?)"\s*\/?>/gi)];
  if (/<QrcInfos\b/i.test(raw) && !attributes.length) throw Error("QQ_LYRICS_INVALID_QRC_XML");
  const text = attributes.length ? attributes.map(match=>lyricEntities(match[1])).join("\n") : raw;
  let offsetMs = 0;
  for(const match of text.matchAll(/\[offset:\s*([+-]?\d+)\s*\]/gi)) if(Number.isSafeInteger(Number(match[1]))) offsetMs=Number(match[1]);
  const lines = [];
  for(const row of text.split(/\r\n|\r|\n/)) {
    const qrc = row.match(/^\s*\[(\d+),(\d+)\]/);
    const cues = qrc ? [Number(qrc[1])/1000] : [...row.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
      .filter(match => Number(match[2])<60).map(match => Number(match[1])*60+Number(match[2])+Number(`0.${match[3]||0}`));
    const body = row.replace(/\[[^\]]+\]/g, "");
    const content = lyricEntities(qrc ? body.replace(/\(\d+,\d+(?:,\d+)?\)/g,"") : body).trim();
    if(!content) continue;
    for(const time of cues) if(Number.isFinite(time)) lines.push({time:time-offsetMs/1000,text:content});
  }
  return lines.sort((a,b)=>a.time-b.time).filter((line,index,all)=>!index||line.time!==all[index-1].time||line.text!==all[index-1].text).slice(0,800);
}

module.exports = { decryptQRC, parseQQLyrics };
