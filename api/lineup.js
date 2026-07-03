// ─────────────────────────────────────────────────────────────
//  /api/lineup  —  신청(Blob)에서 공개용 라인업 데이터만 생성
//
//  공개 항목: 성별 · 나이대 · 키 · 직업 (회차별 그룹)
//  ※ 이름·전화·사진·서류 등 개인정보는 절대 반환하지 않음.
//  환경변수: BLOB_READ_WRITE_TOKEN
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const token = blobToken();
    if (!token) { res.status(200).json({ rounds: [] }); return; }

    const { list } = await import('@vercel/blob');
    const urls = [];
    let cursor;
    do {
      const r = await list({ prefix: 'submissions/', cursor, limit: 1000, token });
      for (const b of r.blobs) urls.push(b.url);
      cursor = r.cursor;
    } while (cursor);

    const subs = [];
    await Promise.all(urls.map(async (u) => {
      try { const r = await fetch(u); if (r.ok) subs.push(await r.json()); } catch (_) {}
    }));

    // 입금완료(확정) 처리된 신청만 라인업에 노출 — confirmed/<orderId>.json 마커 집합
    const confirmedSet = await loadConfirmed(token);

    const year = new Date().getFullYear();
    const map = {};
    // 설정된 회차를 먼저 시드 → 신청 0명인 예정 회차도 노출
    const cfg = await loadRounds(token);
    for (const r of cfg) {
      const m = parseRound(r.label);
      map[r.id] = { roundId: r.id, date: m.date, time: m.time, place: m.place, status: r.soldout ? 'closed' : 'open', hideLineup: !!r.hideLineup, males: [], females: [] };
    }
    for (const s of subs) {
      // 입금완료 누른 신청만 노출 (확정 마커 없으면 라인업에서 제외)
      if (!s.orderId || !confirmedSet.has(String(s.orderId))) continue;
      const rid = s.roundId || s.roundLabel || '기타';
      if (!map[rid]) {
        const m = parseRound(s.roundLabel);
        map[rid] = { roundId: rid, date: m.date, time: m.time, place: m.place, status: 'open', males: [], females: [] };
      }
      // 공개용 칩: 나이대·키구간·직업 (정확한 수치 대신 구간으로 표기) + 한마디
      const chip = [ageBand(s.birthYear, year), heightBand(s.height), cleanJob(s.workplace)].filter(Boolean).join('·');
      if (!chip) continue;
      const entry = { chip, charm: (s.charm || '').trim() };
      const isMale = s.genderCode === 'M' || s.gender === '남성';
      const isFemale = s.genderCode === 'F' || s.gender === '여성';
      if (isMale) map[rid].males.push(entry);
      else if (isFemale) map[rid].females.push(entry);
    }

    // 라인업엔 "다가오는 회차 중 hideLineup이 아닌 회차"를 모두 공개 (회차별 노출은 /admin에서 토글)
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const dated = Object.values(map)
      .map(r => ({ r, d: roundDateFromLabel(r.date, year) }))
      .filter(x => x.d && x.d.getTime() >= today0.getTime() && !x.r.hideLineup)
      .sort((a, b) => a.d - b.d);
    const rounds = dated.slice(0, 2).map(x => x.r);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ rounds });
  } catch (e) {
    console.error('[lineup] 오류:', e);
    res.status(200).json({ rounds: [] });
  }
};

function ageBand(by, year) {
  var y = parseInt(by, 10); if (!y) return '';
  var age = year - y;
  if (age < 10 || age > 99) return '';
  var d = Math.floor(age / 10) * 10;
  var rem = age - d;
  var band = rem <= 3 ? '초' : rem <= 6 ? '중' : '후';
  return d + band;
}
async function loadConfirmed(token) {
  const set = new Set();
  if (!token) return set;
  try {
    const { list } = await import('@vercel/blob');
    let cursor;
    do {
      const r = await list({ prefix: 'confirmed/', cursor, limit: 1000, token });
      for (const b of r.blobs) {
        const id = String(b.pathname || '').replace(/^confirmed\//, '').replace(/\.json$/, '');
        if (id) set.add(id);
      }
      cursor = r.cursor;
    } while (cursor);
  } catch (_) {}
  return set;
}
async function loadRounds(token) {
  if (!token) return [];
  try {
    const { list } = await import('@vercel/blob');
    const r = await list({ prefix: 'config/rounds.json', limit: 1, token });
    if (r.blobs.length) {
      const rr = await fetch(r.blobs[0].url + '?_=' + Date.now());
      if (rr.ok) { const j = await rr.json(); if (Array.isArray(j)) return j; }
    }
  } catch (_) {}
  return [];
}
function roundDateFromLabel(dateStr, year) {
  var m = String(dateStr || '').match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  var mo = parseInt(m[1], 10) - 1, da = parseInt(m[2], 10);
  var d = new Date(year, mo, da);
  var now = new Date();
  if (d.getTime() < now.getTime() - 1000 * 60 * 60 * 24 * 180) d = new Date(year + 1, mo, da); // 연말연초 보정
  return d;
}
function heightBand(h) {
  var n = parseInt(h, 10); if (!n || n < 120 || n > 220) return '';
  var d = Math.floor(n / 10) * 10;
  var rem = n - d;
  var band = rem <= 2 ? '초' : rem <= 5 ? '중' : '후';  // 0~2 초 / 3~5 중 / 6~9 후
  return d + band;
}
function parseRound(label) {
  label = String(label || '');
  var parts = label.split('·');
  var place = parts[1] ? parts[1].trim() : '';
  var left = parts[0] ? parts[0].trim() : label;
  var m = left.match(/(\d{1,2}:\d{2})\s*$/);
  var time = m ? m[1] : '';
  var date = time ? left.replace(/\s*\d{1,2}:\d{2}\s*$/, '').trim() : left;
  return { date: date, time: time, place: place };
}
function cleanJob(job) {
  if (!job) return '';
  return job.replace(/[\/\s]*현재\s*휴직.*$/i, '').trim();
}
function blobToken() {
  var t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) { var k = Object.keys(process.env).find(k => /READ_WRITE_TOKEN$/.test(k)); if (k) t = process.env[k]; }
  return t || '';
}
