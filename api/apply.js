// ─────────────────────────────────────────────────────────────
//  /api/apply  —  결제 없이 신청만 받기 (카카오 알림톡 + 관리자 문자 + 구글시트)
//
//  토스 결제 흐름(/api/confirm) 대신, 신청서만 받고 즉시 알림을 발송합니다.
//  토스 승인 전까지 운영하거나, 현장/계좌 결제로 받을 때 사용.
//
//  필요한 환경변수 (Vercel → Settings → Environment Variables):
//    SOLAPI_API_KEY       솔라피 API Key
//    SOLAPI_API_SECRET    솔라피 API Secret
//    SOLAPI_SENDER        등록된 발신 전화번호 (숫자만, 예: 01012345678)
//    SOLAPI_PFID          카카오 발신프로필 ID (pfId)         ← 고객 알림톡용
//    SOLAPI_TEMPLATE_ID   승인된 알림톡 템플릿 ID             ← 고객 알림톡용
//    ADMIN_PHONE          관리자(호스트) 알림 받을 번호 (선택, 숫자만)
//    GSHEET_WEBHOOK_URL   구글시트 자동기록 웹훅 (선택)
//
//  ※ SOLAPI_* 값이 없으면 → 시트 기록만 하고 메시지는 건너뜁니다(신청은 정상 접수).
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method Not Allowed' });
    return;
  }

  try {
    const body = await readJson(req);
    const { orderId, applicant = {} } = body || {};
    if (!orderId || !applicant.name || !applicant.phone) {
      res.status(400).json({ success: false, message: '신청 정보가 누락되었습니다.' });
      return;
    }
    const amount = Number(applicant.amount) || 0;

    // ── 1) 알림톡/관리자 문자 발송 (실패해도 신청은 접수로 처리) ──
    let messaging = { sent: false, reason: 'skipped' };
    try {
      messaging = await sendMessages({ applicant, orderId, amount });
    } catch (e) {
      messaging = { sent: false, reason: String(e && e.message || e) };
      console.error('[apply alimtalk] 발송 실패:', e);
    }

    // ── 2) 구글시트 자동 기록 (선택, 실패해도 신청은 접수로 처리) ──
    try {
      await sendToSheet({ applicant, orderId, amount });
    } catch (e) {
      console.error('[apply gsheet] 기록 실패:', e);
    }

    // ── 3) Vercel Blob에 신청 원본 저장 (관리자 페이지 /admin 에서 조회) ──
    try {
      await saveSubmission({ applicant, orderId, amount });
    } catch (e) {
      console.error('[apply blob] 저장 실패:', e);
    }

    res.status(200).json({ success: true, messaging });
  } catch (e) {
    console.error('[apply] 오류:', e);
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

  if (!API_KEY || !API_SECRET || !SENDER) {
    return { sent: false, reason: 'solapi-not-configured' };
  }

  // 고객 알림톡은 신청 1시간 뒤 예약발송, 관리자 문자는 즉시 발송으로 분리
  const scheduled = [];  // 1시간 뒤 (고객 알림톡)
  const immediate = [];  // 즉시 (관리자 알림)
  const genderTxt = applicant.gender === 'M' ? '남성' : applicant.gender === 'F' ? '여성' : '';
  const custPhone = onlyDigits(applicant.phone);

  // (1) 고객 알림톡 — 템플릿/발신프로필이 준비된 경우에만 (1시간 뒤 예약)
  if (PFID && TEMPLATE_ID && custPhone) {
    scheduled.push({
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
          '#{금액}': amount ? amount.toLocaleString() + '원' : '',
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
    const line = (label, v) => v ? (label + ': ' + v + '\n') : '';
    const adminText =
      '[언더라이트 신규신청]\n' +
      '이름: ' + (applicant.name || '-') + ' (' + genderTxt + ')\n' +
      line('년생', applicant.birthYear) +
      line('키', applicant.height) +
      line('매력', applicant.charm) +
      '연락처: ' + formatPhone(custPhone) + '\n' +
      line('직장/사업자', applicant.workplace) +
      line('거주지역', applicant.region) +
      line('음료', applicant.drink) +
      line('피하고싶은지인', applicant.avoidName) +
      '회차: ' + (applicant.roundLabel || '-') + '\n' +
      companionLine +
      (amount ? '참가비: ' + amount.toLocaleString() + '원\n' : '') +
      line('사진', applicant.photoUrl) +
      line('서류', applicant.docUrl) +
      '주문: ' + orderId;
    immediate.push({
      to: onlyDigits(ADMIN_PHONE),
      from: onlyDigits(SENDER),
      text: adminText,
    });
  }

  if (scheduled.length === 0 && immediate.length === 0) return { sent: false, reason: 'no-recipients' };

  const out = {};
  // 관리자 문자: 즉시 발송
  if (immediate.length) {
    out.admin = await solapiSend({ API_KEY, API_SECRET, messages: immediate });
  }
  // 고객 알림톡: 즉시 발송
  if (scheduled.length) {
    out.customer = await solapiSend({ API_KEY, API_SECRET, messages: scheduled });
  }
  return { sent: true, result: out };
}

// ─── 솔라피 발송 API 호출 (HMAC-SHA256 인증) ─────────────────────
//  scheduledDate(ISO8601)를 넘기면 해당 시각에 예약 발송됩니다.
async function solapiSend({ API_KEY, API_SECRET, messages, scheduledDate }) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto.createHmac('sha256', API_SECRET).update(date + salt).digest('hex');

  const payload = { messages };
  if (scheduledDate) payload.scheduledDate = scheduledDate;

  const r = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
    method: 'POST',
    headers: {
      'Authorization': `HMAC-SHA256 apiKey=${API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('solapi: ' + (data && (data.errorMessage || JSON.stringify(data))));
  return data;
}

// ─── 구글시트 자동 기록 (Apps Script 웹훅) ────────────────────
async function sendToSheet({ applicant, orderId, amount }) {
  const url = process.env.GSHEET_WEBHOOK_URL;
  if (!url) return; // 미설정 시 건너뜀
  const genderTxt = applicant.gender === 'M' ? '남성' : applicant.gender === 'F' ? '여성' : '';
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: applicant.name || '',
      gender: genderTxt,
      genderCode: applicant.gender || '',
      birthYear: applicant.birthYear || '',
      height: applicant.height || '',
      charm: applicant.charm || '',
      phone: formatPhone(onlyDigits(applicant.phone)),
      workplace: applicant.workplace || '',
      region: applicant.region || '',
      drink: applicant.drink || '',
      avoidName: applicant.avoidName || '',
      roundId: applicant.roundId || '',
      roundLabel: applicant.roundLabel || '',
      amount: Number(amount),
      companion: applicant.companion ? 'O' : '',
      companionName: applicant.companionName || '',
      photoUrl: applicant.photoUrl || '',
      docUrl: applicant.docUrl || '',
      orderId,
    }),
  });
}

// ─── Vercel Blob에 신청 1건 저장 (관리자 조회용) ──────────────
function blobToken() {
  var t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) { var k = Object.keys(process.env).find(k => /READ_WRITE_TOKEN$/.test(k)); if (k) t = process.env[k]; }
  return t || '';
}
async function saveSubmission({ applicant, orderId, amount }) {
  const token = blobToken();
  if (!token) return; // 토큰 없으면 건너뜀
  const genderTxt = applicant.gender === 'M' ? '남성' : applicant.gender === 'F' ? '여성' : '';
  const rec = {
    submittedAt: new Date().toISOString(),
    orderId,
    name: applicant.name || '',
    gender: genderTxt,
    genderCode: applicant.gender || '',
    birthYear: applicant.birthYear || '',
    height: applicant.height || '',
    charm: applicant.charm || '',
    phone: formatPhone(onlyDigits(applicant.phone)),
    workplace: applicant.workplace || '',
    region: applicant.region || '',
    drink: applicant.drink || '',
    avoidName: applicant.avoidName || '',
    roundId: applicant.roundId || '',
    roundLabel: applicant.roundLabel || '',
    amount: Number(amount) || 0,
    companion: applicant.companion ? 'O' : '',
    companionName: applicant.companionName || '',
    photoUrl: applicant.photoUrl || '',
    docUrl: applicant.docUrl || '',
  };
  const { put } = await import('@vercel/blob');
  await put('submissions/' + orderId + '.json', Buffer.from(JSON.stringify(rec)), {
    access: 'public',
    addRandomSuffix: true,   // 추측 불가능한 URL (개인정보 보호)
    contentType: 'application/json',
    token,
  });
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
