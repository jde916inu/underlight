// ─────────────────────────────────────────────────────────────
//  /api/rounds  —  신청 회차(날짜) 관리
//
//  GET            → { rounds: [{id,label,soldout}] }  (공개: 신청카드/라인업용)
//  POST ?key=ADMIN_KEY  body { action:'add', date, time, place }   → 회차 추가
//  POST ?key=ADMIN_KEY  body { action:'delete', id }               → 회차 삭제
//  POST ?key=ADMIN_KEY  body { action:'soldout', id, soldout }     → 마감 토글
//  저장: Vercel Blob  config/rounds.json
// ─────────────────────────────────────────────────────────────
const DEFAULT_ROUNDS = [
  { id: '0619', label: '6/19 (금) 20:40 · 풍산역 5분', soldout: false },
];

module.exports = async (req, res) => {
  try {
    const token = blobToken();

    if (req.method === 'GET') {
      const rounds = await loadRounds(token);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ rounds });
      return;
    }

    // 변경은 관리자 키 필요
    const key = getParam(req, 'key');
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!token) { res.status(500).json({ error: 'BLOB 토큰이 없습니다.' }); return; }

    const body = await readJson(req);
    let rounds = await loadRounds(token);
    const action = (body && body.action) || '';

    if (action === 'add') {
      const date = (body.date || '').trim();
      const time = (body.time || '').trim();
      const place = (body.place || '풍산역 5분').trim();
      if (!date) { res.status(400).json({ error: '날짜를 입력하세요.' }); return; }
      const label = [date, time].filter(Boolean).join(' ') + (place ? ' · ' + place : '');
      const id = (body.id && String(body.id).trim()) || ('r' + Date.now());
      rounds.push({ id, label, soldout: false });
    } else if (action === 'edit') {
      // 기존 회차의 날짜·시간·장소를 id 유지한 채 수정 (신청 연결 보존)
      const id = body.id;
      const date = (body.date || '').trim();
      const time = (body.time || '').trim();
      const place = (body.place || '').trim();
      rounds = rounds.map(r => {
        if (r.id !== id) return r;
        const label = [date, time].filter(Boolean).join(' ') + (place ? ' · ' + place : '');
        return Object.assign({}, r, { label });
      });
    } else if (action === 'replace') {
      // 전체 회차 배열을 한 번에 교체 (원자적 — race 방지)
      if (!Array.isArray(body.rounds)) { res.status(400).json({ error: 'rounds 배열이 필요합니다.' }); return; }
      rounds = body.rounds
        .filter(r => r && r.id && r.label)
        .map(r => ({ id: String(r.id), label: String(r.label), soldout: !!r.soldout, hideLineup: !!r.hideLineup }));
    } else if (action === 'delete') {
      const id = body.id;
      rounds = rounds.filter(r => r.id !== id);
    } else if (action === 'soldout') {
      rounds = rounds.map(r => r.id === body.id ? Object.assign({}, r, { soldout: !!body.soldout }) : r);
    } else if (action === 'lineup') {
      // 라인업 노출 토글 — hideLineup=true 면 공개 라인업에서 숨김 (신청은 계속 받음)
      rounds = rounds.map(r => r.id === body.id ? Object.assign({}, r, { hideLineup: !!body.hideLineup }) : r);
    } else {
      res.status(400).json({ error: '알 수 없는 action' }); return;
    }

    await saveRounds(token, rounds);
    res.status(200).json({ ok: true, rounds });
  } catch (e) {
    console.error('[rounds] 오류:', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

async function loadRounds(token) {
  if (!token) return DEFAULT_ROUNDS;
  try {
    const { list } = await import('@vercel/blob');
    const r = await list({ prefix: 'config/rounds.json', limit: 1, token });
    if (r.blobs.length) {
      const rr = await fetch(r.blobs[0].url + '?_=' + Date.now());
      if (rr.ok) { const j = await rr.json(); if (Array.isArray(j)) return j; }
    }
  } catch (_) {}
  return DEFAULT_ROUNDS;
}
async function saveRounds(token, rounds) {
  const { put } = await import('@vercel/blob');
  await put('config/rounds.json', Buffer.from(JSON.stringify(rounds)), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
    cacheControlMaxAge: 0, token,
  });
}
function getParam(req, name) {
  if (req.query && req.query[name]) return req.query[name];
  try { return new URL(req.url, 'http://x').searchParams.get(name) || ''; } catch (_) { return ''; }
}
function blobToken() {
  var t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) { var k = Object.keys(process.env).find(k => /READ_WRITE_TOKEN$/.test(k)); if (k) t = process.env[k]; }
  return t || '';
}
function readJson(req) {
  return new Promise((resolve) => {
    if (req.body) { try { return resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); } catch (_) { return resolve({}); } }
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
