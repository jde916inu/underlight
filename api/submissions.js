// ─────────────────────────────────────────────────────────────
//  /api/submissions  —  Blob에 저장된 신청 목록 반환 (관리자 전용)
//
//  보호: ?key=<ADMIN_KEY> 가 환경변수 ADMIN_KEY와 일치해야 함.
//  환경변수: ADMIN_KEY, BLOB_READ_WRITE_TOKEN
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  try {
    const key = getKey(req);
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const token = blobToken();
    if (!token) { res.status(500).json({ error: 'BLOB 토큰이 없습니다.' }); return; }

    const { list, del, put } = await import('@vercel/blob');

    // ── 수정: 특정 신청(orderId)의 공개 노출 필드 수정 ──
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readJson(req);
      const orderId = (body && body.orderId) || getParam(req, 'orderId');
      const patch = (body && body.patch) || {};
      if (!orderId) { res.status(400).json({ error: 'orderId가 필요합니다.' }); return; }
      const ALLOWED = ['charm', 'workplace', 'birthYear', 'height', 'roundId', 'roundLabel'];
      const r = await list({ prefix: 'submissions/' + orderId, limit: 10, token });
      if (!r.blobs.length) { res.status(404).json({ error: '해당 신청을 찾을 수 없습니다.' }); return; }
      let updated = 0;
      for (const b of r.blobs) {
        let rec;
        try { const rr = await fetch(b.url); if (rr.ok) rec = await rr.json(); } catch (_) {}
        if (!rec) continue;
        for (const k of ALLOWED) { if (Object.prototype.hasOwnProperty.call(patch, k)) rec[k] = String(patch[k]); }
        await put(b.pathname, Buffer.from(JSON.stringify(rec)), {
          access: 'public', addRandomSuffix: false, allowOverwrite: true,
          contentType: 'application/json', token,
        });
        updated++;
      }
      res.status(200).json({ ok: true, updated });
      return;
    }

    // ── 삭제: 특정 신청(orderId) 제거 ──
    if (req.method === 'DELETE') {
      const orderId = getParam(req, 'orderId');
      if (!orderId) { res.status(400).json({ error: 'orderId가 필요합니다.' }); return; }
      const r = await list({ prefix: 'submissions/' + orderId, limit: 1000, token });
      await Promise.all(r.blobs.map(b => del(b.url, { token })));
      // 확정 마커도 함께 제거
      try {
        const cr = await list({ prefix: 'confirmed/' + orderId, limit: 10, token });
        await Promise.all(cr.blobs.map(b => del(b.url, { token })));
      } catch (_) {}
      res.status(200).json({ ok: true, deleted: r.blobs.length });
      return;
    }

    // ── 조회: 전체 목록 ──
    const urls = [];
    let cursor;
    do {
      const r = await list({ prefix: 'submissions/', cursor, limit: 1000, token });
      for (const b of r.blobs) urls.push(b.url);
      cursor = r.cursor;
    } while (cursor);

    const submissions = [];
    await Promise.all(urls.map(async (u) => {
      try {
        const r = await fetch(u);
        if (r.ok) submissions.push(await r.json());
      } catch (_) { /* skip broken */ }
    }));

    // 확정(입금완료) 마킹 조회
    const confirmedSet = new Set();
    try {
      let c2;
      do {
        const cr = await list({ prefix: 'confirmed/', cursor: c2, limit: 1000, token });
        for (const b of cr.blobs) { const m = b.pathname.match(/confirmed\/(.+)\.json$/); if (m) confirmedSet.add(m[1]); }
        c2 = cr.cursor;
      } while (c2);
    } catch (_) {}
    submissions.forEach(s => { s.confirmed = confirmedSet.has(s.orderId); });

    submissions.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    res.status(200).json({ count: submissions.length, submissions });
  } catch (e) {
    console.error('[submissions] 오류:', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

function getKey(req) { return getParam(req, 'key'); }
function getParam(req, name) {
  if (req.query && req.query[name]) return req.query[name];
  try { return new URL(req.url, 'http://x').searchParams.get(name) || ''; }
  catch (_) { return ''; }
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
