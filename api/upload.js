// ─────────────────────────────────────────────────────────────
//  /api/upload  —  신청서 첨부파일(본인사진·신원확인 서류)을 Vercel Blob에 저장
//
//  환경변수: BLOB_READ_WRITE_TOKEN
//    (Vercel → Storage → Blob 스토어 연결 시 자동 주입됨)
//
//  요청(JSON): { filename, contentType, dataBase64 }  // base64 (data URL 헤더 제외)
//  응답(JSON): { url }
//
//  ※ Vercel 함수 본문 한도(약 4.5MB) 때문에 이미지는 클라이언트에서 압축 후 전송.
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
  try {
    const body = await readJson(req);
    const { filename, contentType, dataBase64 } = body || {};
    if (!dataBase64) { res.status(400).json({ error: '파일 데이터가 없습니다.' }); return; }
    // 토큰: 기본 이름 우선, 없으면 *_READ_WRITE_TOKEN 형태 자동 탐색
    var token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      var key = Object.keys(process.env).find(k => /READ_WRITE_TOKEN$/.test(k));
      if (key) token = process.env[key];
    }
    if (!token) {
      res.status(500).json({ error: '서버에 BLOB_READ_WRITE_TOKEN이 설정되지 않았습니다.' });
      return;
    }
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > 8 * 1024 * 1024) { res.status(413).json({ error: '파일이 너무 큽니다 (8MB 이하).' }); return; }

    const safe = String(filename || 'file').replace(/[^\w.\-가-힣]/g, '_').slice(0, 60);
    const { put } = await import('@vercel/blob');
    const blob = await put('applications/' + safe, buffer, {
      access: 'public',
      addRandomSuffix: true,          // 추측 불가능한 URL
      contentType: contentType || 'application/octet-stream',
      token: token,
    });
    res.status(200).json({ url: blob.url });
  } catch (e) {
    console.error('[upload] 오류:', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

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
