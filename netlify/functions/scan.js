const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const DOMAINS = ['alight.link', 'alightmotion.com', 'alightcreative.com', 'alightmotion.app.link', 'alight-creative.app.link', 'alightmotion.page.link'];
const ALIGHT = new RegExp('(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(?:' + DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|') + ')\\/[^\\s"\'<>\\\\)\\]]+', 'gi');

async function get(u, opts = {}, ms = 6000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(u, {
      redirect: 'follow', ...opts, signal: c.signal,
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
    });
  } finally { clearTimeout(t); }
}

function extract(text) {
  if (!text) return [];
  const clean = String(text).replace(/\\u002F/gi, '/').replace(/&amp;/g, '&');
  const found = clean.match(ALIGHT) || [];
  return found.map(l => l.replace(/[.,;:!?]+$/, '')).map(l => (/^https?:\/\//i.test(l) ? l : 'https://' + l));
}

async function fetchComments(id, cookie, warnings) {
  const comments = [];
  try {
    for (let cursor = 0; cursor < 100; cursor += 50) {
      const r = await get(`https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=${id}&count=50&cursor=${cursor}`,
        { headers: { cookie, referer: 'https://www.tiktok.com/' } });
      const d = await r.json();
      if (!d.comments || !d.comments.length) break;
      comments.push(...d.comments);
      if (!d.has_more) break;
    }
  } catch (e) { /* handled below */ }
  if (!comments.length) warnings.push('Komentar gak bisa diambil (TikTok sering ngeblok bagian ini), jadi komentar & balasan gak ikut dipindai.');
  return comments;
}

async function fetchReplies(id, cookie, comments) {
  const withReplies = comments.filter(c => c.reply_comment_total > 0).slice(0, 20);
  const out = await Promise.all(withReplies.map(async c => {
    try {
      const r = await get(`https://www.tiktok.com/api/comment/list/reply/?aid=1988&comment_id=${c.cid}&item_id=${id}&count=50&cursor=0`,
        { headers: { cookie, referer: 'https://www.tiktok.com/' } });
      const d = await r.json();
      return d.comments || [];
    } catch (e) { return []; }
  }));
  return out.flat();
}

exports.extract = extract;

exports.handler = async (event) => {
  const H = { 'content-type': 'application/json; charset=utf-8' };
  const send = (code, obj) => ({ statusCode: code, headers: H, body: JSON.stringify(obj) });
  const warnings = [];

  let u;
  try { u = new URL(((event.queryStringParameters || {}).url || '').trim()); }
  catch (e) { return send(400, { ok: false, error: 'Link gak valid.' }); }
  if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return send(400, { ok: false, error: 'Itu bukan link TikTok.' });

  let page, html;
  try {
    page = await get(u.href, {}, 8000);
    html = await page.text();
  } catch (e) {
    return send(502, { ok: false, error: 'Gagal buka link TikTok. Coba lagi bentar.' });
  }

  const cookies = typeof page.headers.getSetCookie === 'function'
    ? page.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') : '';

  let item = null;
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try { item = JSON.parse(m[1]).__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct; } catch (e) { item = null; }
  }

  const sources = [];
  let videoId = ((page.url || '').match(/\/video\/(\d+)/) || [])[1];
  let bioLink = '';
  if (item) {
    videoId = videoId || item.id;
    const a = item.author || {};
    bioLink = (a.bioLink && a.bioLink.link) || '';
    sources.push({ src: 'Deskripsi video', text: item.desc });
    sources.push({ src: 'Bio akun', text: a.signature });
    sources.push({ src: 'Link di bio', text: bioLink });
  } else {
    warnings.push('Data video gak kebaca (video private, dihapus, atau diblok TikTok). Cuma halaman mentahnya yang dipindai.');
    sources.push({ src: 'Halaman video', text: html });
  }

  if (bioLink && /^https:\/\/[^/]*\.[^/]+/i.test(bioLink) && !/^https:\/\/(\d{1,3}\.){3}/.test(bioLink)) {
    try { sources.push({ src: 'Halaman link bio', text: await (await get(bioLink, {}, 5000)).text() }); }
    catch (e) { warnings.push('Halaman link di bio gak bisa dibuka.'); }
  }

  let comments = [], replies = [];
  if (videoId) {
    comments = await fetchComments(videoId, cookies, warnings);
    replies = comments.length ? await fetchReplies(videoId, cookies, comments) : [];
    comments.forEach(c => sources.push({ src: 'Komentar', text: c.text }));
    replies.forEach(c => sources.push({ src: 'Balasan komentar', text: c.text }));
  }

  const seen = new Map();
  for (const s of sources) for (const link of extract(s.text)) {
    const k = link.toLowerCase();
    if (!seen.has(k)) seen.set(k, { url: link, source: s.src });
  }

  return send(200, {
    ok: true,
    presets: [...seen.values()],
    scanned: { komentar: comments.length, balasan: replies.length, bio: !!item },
    warnings,
  });
};
