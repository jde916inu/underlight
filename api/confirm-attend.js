// ─────────────────────────────────────────────────────────────
//  /api/confirm-attend  —  입금 확인 → 참석확정 알림톡 발송 + '확정' 마킹
//
//  보호: ?key=<ADMIN_KEY>. POST { orderId }.
//  환경변수:
//    ADMIN_KEY, BLOB_READ_WRITE_TOKEN
//    SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER, SOLAPI_PFID
//    SOLAPI_CONFIRM_TEMPLATE_ID   ← '참석확정안내' 승인 템플릿 ID
//    ATTEND_VENUE                 ← 정확한 장소(주소). 없으면 회차의 장소 사용
//  ※ 솔라피 미설정이어도 '확정' 마킹은 됩니다(추적용). 키 넣으면 발송까지 자동.
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
    const key = getParam(req, 'key');
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) { res.status(401).json({ error: 'unauthorized' }); return; }

    const body = await readJson(req);
    const orderId = (body && body.orderId) || getParam(req, 'orderId');
    if (!orderId) { res.status(400).json({ error: 'orderId가 필요합니다.' }); return; }

    const token = blobToken();
    if (!token) { res.status(500).json({ error: 'BLOB 토큰이 없습니다.' }); return; }
    const { list, put, del } = await import('@vercel/blob');

    // ── 확정 마킹만 (알림톡 없이) — 라인업 노출용 마커만 생성 ──
    if (body && body.action === 'mark') {
      try {
        await put('confirmed/' + orderId + '.json', Buffer.from(JSON.stringify({ orderId, confirmedAt: new Date().toISOString(), via: 'mark' })), {
          access: 'public', addRandomSuffix: false, contentType: 'application/json', token, allowOverwrite: true,
        });
      } catch (e) { res.status(500).json({ error: '마킹 실패: ' + String(e && e.message || e) }); return; }
      res.status(200).json({ ok: true, marked: true });
      return;
    }

    // ── 라인업에서 제외(확정 취소): 신청 원본(DB)은 그대로 두고 확정 마커만 삭제 ──
    if (body && body.action === 'unconfirm') {
      let removed = 0;
      try {
        const cr = await list({ prefix: 'confirmed/' + orderId, limit: 10, token });
        await Promise.all(cr.blobs.map(b => del(b.url, { token })));
        removed = cr.blobs.length;
      } catch (e) { console.error('[confirm-attend] 마커 삭제 실패:', e); }
      res.status(200).json({ ok: true, unconfirmed: true, removed });
      return;
    }

    // 신청 원본 찾기
    const r = await list({ prefix: 'submissions/' + orderId, limit: 10, token });
    let sub = null;
    for (const b of r.blobs) { try { const rr = await fetch(b.url); if (rr.ok) { sub = await rr.json(); break; } } catch (_) {} }
    if (!sub) { res.status(404).json({ error: '해당 신청을 찾을 수 없습니다.' }); return; }

    // 알림톡 발송 (솔라피 설정 시)
    let messaging = { sent: false, reason: 'solapi-not-configured' };
    try { messaging = await sendConfirm(sub); }
    catch (e) { messaging = { sent: false, reason: String(e && e.message || e) }; console.error('[confirm-attend] 발송 실패:', e); }

    // '확정' 마킹 (추적용) — 예측 가능한 경로로 덮어쓰기
    try {
      await put('confirmed/' + orderId + '.json', Buffer.from(JSON.stringify({ orderId, confirmedAt: new Date().toISOString() })), {
        access: 'public', addRandomSuffix: false, contentType: 'application/json', token, allowOverwrite: true,
      });
    } catch (e) { console.error('[confirm-attend] 마킹 실패:', e); }

    res.status(200).json({ ok: true, messaging });
  } catch (e) {
    console.error('[confirm-attend] 오류:', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// ─── 참석확정 알림톡 발송 ─────────────────────────────────────
async function sendConfirm(sub) {
  const API_KEY = process.env.SOLAPI_API_KEY;
  const API_SECRET = process.env.SOLAPI_API_SECRET;
  const SENDER = process.env.SOLAPI_SENDER;
  const PFID = process.env.SOLAPI_PFID;
  const TEMPLATE_ID = process.env.SOLAPI_CONFIRM_TEMPLATE_ID;
  if (!API_KEY || !API_SECRET || !SENDER) return { sent: false, reason: 'solapi-not-configured' };
  if (!PFID || !TEMPLATE_ID) return { sent: false, reason: 'template-not-configured' };

  const phone = onlyDigits(sub.phone);
  if (!phone) return { sent: false, reason: 'no-phone' };
  const venue = process.env.ATTEND_VENUE || (sub.roundLabel ? String(sub.roundLabel).split('·').slice(1).join('·').trim() : '') || '안내드린 장소';

  const message = {
    to: phone,
    from: onlyDigits(SENDER),
    type: 'ATA',
    kakaoOptions: {
      pfId: PFID,
      templateId: TEMPLATE_ID,
      variables: {
        '#{이름}': sub.name || '',
        // 일시엔 날짜·시간만 (장소는 #{장소}로 별도 — 라벨에 박힌 옛 장소와 충돌 방지)
        '#{일시}': sub.roundLabel ? String(sub.roundLabel).split('·')[0].trim() : '',
        '#{장소}': venue,
      },
      disableSms: false,
    },
  };
  const result = await solapiSend({ API_KEY, API_SECRET, messages: [message] });
  return { sent: true, result };
}

async function solapiSend({ API_KEY, API_SECRET, messages }) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto.createHmac('sha256', API_SECRET).update(date + salt).digest('hex');
  const r = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
    method: 'POST',
    headers: {
      'Authorization': `HMAC-SHA256 apiKey=${API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('solapi: ' + (data && (data.errorMessage || JSON.stringify(data))));
  return data;
}

// ─── 유틸 ────────────────────────────────────────────────────
function onlyDigits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
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
