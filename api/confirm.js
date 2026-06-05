// ─────────────────────────────────────────────────────────────
//  /api/confirm  —  토스 결제 검증 + 카카오 알림톡 발송 (Vercel 서버리스)
//
//  필요한 환경변수 (Vercel → Settings → Environment Variables):
//    TOSS_SECRET_KEY      토스 시크릿 키 (test_sk_... / live_sk_...)
//    SOLAPI_API_KEY       솔라피 API Key
//    SOLAPI_API_SECRET    솔라피 API Secret
//    SOLAPI_SENDER        등록된 발신 전화번호 (숫자만, 예: 01012345678)
//    SOLAPI_PFID          카카오 발신프로필 ID (pfId)
//    SOLAPI_TEMPLATE_ID   승인된 알림톡 템플릿 ID
//    ADMIN_PHONE          관리자(호스트) 알림 받을 번호 (선택, 숫자만)
//
//  ※ 위 SOLAPI_* 값이 아직 없으면 → 결제 검증만 하고 알림톡은 건너뜁니다.
//     (토스 결제 흐름을 먼저 테스트할 수 있게)
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');

const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method Not Allowed' });
    return;
  }

  try {
    const body = await readJson(req);
    const { paymentKey, orderId, amount, applicant = {}, fbp = '', fbc = '', eventSourceUrl = '' } = body || {};

    if (!paymentKey || !orderId || !amount) {
      res.status(400).json({ success: false, message: '결제 정보가 누락되었습니다.' });
      return;
    }
    if (!TOSS_SECRET_KEY) {
      res.status(500).json({ success: false, message: '서버에 TOSS_SECRET_KEY가 설정되지 않았습니다.' });
      return;
    }

    // ── 1) 토스페이먼츠 결제 승인(검증) ───────────────────────────
    const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(TOSS_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const toss = await tossRes.json();

    if (!tossRes.ok) {
      // 이미 처리된 결제(새로고침 등)는 성공으로 간주하되 알림톡 재발송은 생략
      if (toss && toss.code === 'ALREADY_PROCESSED_PAYMENT') {
        res.status(200).json({ success: true, alreadyProcessed: true });
        return;
      }
      res.status(400).json({ success: false, message: (toss && toss.message) || '결제 승인에 실패했습니다.' });
      return;
    }

    // ── 2) 알림톡 발송 (실패해도 결제는 이미 성공이므로 막지 않음) ──
    let messaging = { sent: false, reason: 'skipped' };
    try {
      messaging = await sendMessages({ applicant, orderId, amount: Number(amount) });
    } catch (e) {
      messaging = { sent: false, reason: String(e && e.message || e) };
      console.error('[alimtalk] 발송 실패:', e);
    }

    // ── 3) Meta 전환 API (서버 전송) — 실패해도 결제는 성공 처리 ──
    try {
      await sendMetaCapi({
        orderId, amount: Number(amount), applicant, fbp, fbc, eventSourceUrl,
        clientIp: (req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
        userAgent: req.headers['user-agent'] || '',
      });
    } catch (e) {
      console.error('[meta capi] 전송 실패:', e);
    }

    res.status(200).json({ success: true, messaging });
  } catch (e) {
    console.error('[confirm] 오류:', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
};

// ─── 메시지 발송 (고객 알림톡 + 관리자 알림) ──────────────────────
async function sendMessages({ applicant, orderId, amount }) {
  const API_KEY     = process.env.SOLAPI_API_KEY;
  const API_SECRET  = process.env.SOLAPI_API_SECRET;
  const SENDER      = process.env.SOLAPI_SENDER;
  const PFID        = process.env.SOLAPI_PFID;
  const TEMPLATE_ID = process.env.SOLAPI_TEMPLATE_ID;
  const ADMIN_PHONE = process.env.ADMIN_PHONE;

  // 솔라피 설정이 아직 없으면 발송 건너뜀 (토스 흐름만 테스트하는 단계)
  if (!API_KEY || !API_SECRET || !SENDER) {
    return { sent: false, reason: 'solapi-not-configured' };
  }

  const messages = [];
  const genderTxt = applicant.gender === 'M' ? '남성' : applicant.gender === 'F' ? '여성' : '';
  const custPhone = onlyDigits(applicant.phone);

  // (1) 고객 알림톡 — 템플릿/발신프로필이 준비된 경우에만
  if (PFID && TEMPLATE_ID && custPhone) {
    messages.push({
      to: custPhone,
      from: onlyDigits(SENDER),
      type: 'ATA',
      kakaoOptions: {
        pfId: PFID,
        templateId: TEMPLATE_ID,
        // 승인받은 템플릿의 변수명에 맞춰 키를 바꿔주세요 (예: #{이름}, #{회차})
        variables: {
          '#{이름}': applicant.name || '',
          '#{회차}': applicant.roundLabel || '',
          '#{금액}': Number(amount).toLocaleString() + '원',
        },
        disableSms: false, // 알림톡 실패 시 문자로 대체 발송
      },
    });
  }

  // (2) 관리자 알림 (일반 문자) — 새 신청 즉시 호스트에게
  if (ADMIN_PHONE) {
    const companionLine = applicant.companion
      ? '동반: O' + (applicant.companionName ? ' (' + applicant.companionName + ')' : '') + '\n'
      : '';
    const adminText =
      '[언더라이트 신규신청]\n' +
      '이름: ' + (applicant.name || '-') + ' (' + genderTxt + ')\n' +
      '연락처: ' + formatPhone(custPhone) + '\n' +
      '회차: ' + (applicant.roundLabel || '-') + '\n' +
      companionLine +
      '결제: ' + Number(amount).toLocaleString() + '원\n' +
      '주문: ' + orderId;
    messages.push({
      to: onlyDigits(ADMIN_PHONE),
      from: onlyDigits(SENDER),
      text: adminText,
      // 길이에 따라 자동으로 SMS/LMS 처리됨
    });
  }

  if (messages.length === 0) return { sent: false, reason: 'no-recipients' };

  const result = await solapiSend({ API_KEY, API_SECRET, messages });
  return { sent: true, result };
}

// ─── 솔라피 발송 API 호출 (HMAC-SHA256 인증) ─────────────────────
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

// ─── Meta 전환 API(CAPI) 서버 전송 ───────────────────────────
//   환경변수: META_CAPI_TOKEN (필수), META_PIXEL_ID (선택, 기본값 아래)
//   클라이언트 픽셀 Purchase와 같은 event_id(orderId)로 중복제거됨.
async function sendMetaCapi({ orderId, amount, applicant, fbp, fbc, eventSourceUrl, clientIp, userAgent }) {
  const TOKEN = process.env.META_CAPI_TOKEN;
  const PIXEL_ID = process.env.META_PIXEL_ID || '986459453871241';
  if (!TOKEN) return; // 토큰 없으면 조용히 건너뜀

  const phone = normalizeKrPhoneForMeta(applicant.phone);
  const user_data = {};
  if (phone) user_data.ph = [sha256(phone)];
  if (applicant.name) user_data.fn = [sha256(String(applicant.name).trim().toLowerCase())];
  if (clientIp)  user_data.client_ip_address = clientIp;
  if (userAgent) user_data.client_user_agent = userAgent;
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: orderId,                 // 클라이언트 fbq eventID와 동일 → 중복제거
      action_source: 'website',
      event_source_url: eventSourceUrl || undefined,
      user_data,
      custom_data: {
        value: Number(amount),
        currency: 'KRW',
        content_name: applicant.roundLabel || '',
      },
    }],
  };

  const url = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(TOKEN)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('capi: ' + t);
  }
}
function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function normalizeKrPhoneForMeta(v) {
  let d = onlyDigits(v);
  if (!d) return '';
  if (d.startsWith('0')) d = '82' + d.slice(1); // 010... → 8210...
  else if (!d.startsWith('82')) d = '82' + d;
  return d;
}

// ─── 유틸 ────────────────────────────────────────────────────
function onlyDigits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
function formatPhone(d) {
  d = onlyDigits(d);
  if (d.length === 11) return d.slice(0,3) + '-' + d.slice(3,7) + '-' + d.slice(7);
  return d;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body) { // Vercel이 이미 파싱한 경우
      try { return resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); }
      catch (e) { return reject(e); }
    }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
