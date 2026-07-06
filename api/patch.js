// /api/patch — 관리자용: 신청 레코드의 특정 필드 수정
// POST { adminKey, orderId, field, value }
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  try {
    const body = await readJson(req);
    const { adminKey, orderId, field, value } = body || {};
    if (adminKey !== (process.env.ADMIN_KEY || 'underlight2026')) {
      res.status(403).json({ ok: false, error: 'unauthorized' }); return;
    }
    if (!orderId || !field) {
      res.status(400).json({ ok: false, error: 'orderId and field required' }); return;
    }

    const ALLOWED = ['charm', 'workplace', 'region', 'height', 'birthYear', 'drink', 'avoidName', 'companion', 'companionName', 'amount'];
    if (!ALLOWED.includes(field)) {
      res.status(400).json({ ok: false, error: 'field not allowed' }); return;
    }

    const token = blobToken();
    if (!token) { res.status(500).json({ ok: false, error: 'no blob token' }); return; }

    const { list, put } = await import('@vercel/blob');
    // submissions/ 에서 orderId 포함 blob 찾기
    let targetBlob = null;
    let cursor;
    do {
      const r = await list({ prefix: 'submissions/', cursor, limit: 1000, token });
      for (const b of r.blobs) {
        if (b.pathname.includes(orderId)) { targetBlob = b; break; }
      }
      cursor = r.cursor;
    } while (cursor && !targetBlob);

    if (!targetBlob) { res.status(404).json({ ok: false, error: 'submission not found' }); return; }

    const resp = await fetch(targetBlob.url + '?_=' + Date.now());
    if (!resp.ok) { res.status(500).json({ ok: false, error: 'fetch failed' }); return; }
    const rec = await resp.json();

    rec[field] = value;

    await put(targetBlob.pathname, Buffer.from(JSON.stringify(rec)), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      token,
    });

    res.status(200).json({ ok: true, updated: { [field]: value } });
  } catch (e) {
    console.error('[patch]', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

function blobToken() {
  var t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) { var k = Object.keys(process.env).find(k => /READ_WRITE_TOKEN$/.test(k)); if (k) t = process.env[k]; }
  return t || '';
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body) {
      try { return resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); }
      catch (e) { return reject(e); }
    }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
