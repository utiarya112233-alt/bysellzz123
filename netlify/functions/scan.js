// Netlify Function: scan TikTok video (desc, bio, bio link, comments, replies) for Alight Motion preset links
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_DESK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DOMAINS = ['alight.link', 'alightmotion.com', 'alightcreative.com', 'alightmotion.app.link', 'alight-creative.app.link', 'alightmotion.page.link'];
const ALIGHT = new RegExp('(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(?:' + DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|') + ')\\/[^\\s"\'<>\\\\)\\]]+', 'gi');

const FILE = new RegExp('(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(?:drive\\.google\\.com|docs\\.google\\.com|mediafire\\.com|mega\\.nz|dropbox\\.com|sfile\\.mobi|catbox\\.moe)\\/[^\\s"\'<>\\\\)\\]]+', 'gi');

function extractFiles(text) {
  const clean = String(text || '').replace(/\\u002F/gi, '/').replace(/&amp;/g, '&');
  const re = new RegExp(FILE.source, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(clean))) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const tag = (clean.slice(Math.max(0, m.index - 60), m.index).match(/\d{1,2}:\d{1,2}/g) || []).pop() || '';
    out.push({ url: /^https?:\/\//i.test(url) ? url : 'https://' + url, tag });
  }
  return out;
}

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
  const pages = await Promise.all([0, 50, 100, 150, 200].map(async cursor => {
    try {
      const r = await get(`https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=${id}&count=50&cursor=${cursor}`,
        { headers: { cookie, referer: 'https://www.tiktok.com/' } }, 6000);
      const d = await r.json();
      return d.comments || [];
    } catch (e) { return []; }
  }));
  const seenIds = new Set();
  const comments = pages.flat().filter(c => c && !seenIds.has(c.cid) && seenIds.add(c.cid));
  if (!comments.length) warnings.push('Komentar gak bisa diambil (TikTok sering ngeblok bagian ini), jadi komentar & balasan gak ikut dipindai.');
  return comments;
}

async function fetchReplies(id, cookie, comments) {
  const withReplies = comments.filter(c => c.reply_comment_total > 0).slice(0, 40);
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
exports.extractFiles = extractFiles;

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

  const parseScope = (h, key) => {
    const mm = h.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!mm) return null;
    try { return JSON.parse(mm[1]).__DEFAULT_SCOPE__[key]; } catch (e) { return null; }
  };
  let item = null;
  const d1 = parseScope(html, 'webapp.video-detail');
  if (d1 && d1.itemInfo) item = d1.itemInfo.itemStruct;
  if (!item) {
    try {
      const r2 = await get(u.href, { headers: { 'user-agent': UA_DESK } }, 8000);
      const d2 = parseScope(await r2.text(), 'webapp.video-detail');
      if (d2 && d2.itemInfo) item = d2.itemInfo.itemStruct;
    } catch (e) { /* lanjut ke cadangan */ }
  }

  const sources = [];
  let videoId = ((page.url || '').match(/\/video\/(\d+)/) || [])[1];
  let bioLink = '';
  let gotInfo = false;
  if (item) {
    gotInfo = true;
    videoId = videoId || item.id;
    const a = item.author || {};
    bioLink = (a.bioLink && a.bioLink.link) || '';
    sources.push({ src: 'Deskripsi video', text: item.desc });
    sources.push({ src: 'Bio akun', text: a.signature });
    sources.push({ src: 'Link di bio', text: bioLink });
  } else {
    let uname = '';
    try {
      const r = await get('https://www.tiktok.com/oembed?url=' + encodeURIComponent(page.url || u.href), {}, 6000);
      const o = await r.json();
      if (o.title) { sources.push({ src: 'Deskripsi video', text: o.title }); gotInfo = true; }
      uname = o.author_unique_id || '';
    } catch (e) { /* abaikan */ }
    const mt = html.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i);
    if (mt) { sources.push({ src: 'Deskripsi video', text: mt[1] }); gotInfo = true; }
    if (!uname) { const um = (page.url || '').match(/tiktok\.com\/@([^/?]+)/); uname = um ? um[1] : ''; }
    if (uname) {
      try {
        const r = await get('https://www.tiktok.com/@' + encodeURIComponent(uname), {}, 6000);
        const du = parseScope(await r.text(), 'webapp.user-detail');
        const usr = du && du.userInfo && du.userInfo.user;
        if (usr) {
          bioLink = (usr.bioLink && usr.bioLink.link) || '';
          sources.push({ src: 'Bio akun', text: usr.signature });
          sources.push({ src: 'Link di bio', text: bioLink });
          gotInfo = true;
        }
      } catch (e) { /* abaikan */ }
    }
    sources.push({ src: 'Halaman video', text: html });
    if (!gotInfo) warnings.push('Deskripsi & bio akun gak kebaca (diblok TikTok atau video private). Komentar tetap dipindai.');
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
  const add = (url, source) => { const k = url.toLowerCase(); if (!seen.has(k)) seen.set(k, { url, source }); };
  for (const s of sources) {
    const al = extract(s.text);
    al.forEach(link => add(link, s.src));
    if (al.length) extractFiles(s.text).forEach(f => add(f.url, s.src + ' · XML' + (f.tag ? ' ' + f.tag : '')));
  }
  warnings.push('[scan v4]');

  return send(200, {
    ok: true,
    presets: [...seen.values()],
    scanned: { komentar: comments.length, balasan: replies.length, bio: gotInfo },
    warnings,
  });
};
