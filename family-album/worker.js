// 가족 앨범 Worker — R2 사진 저장 + 유튜브 영상 목록
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ok = (data) => new Response(JSON.stringify(data), { headers: JSON_HEADERS });
const err = (msg, status = 400) => new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS });

const VIDEOS_KEY = 'meta/videos.json';
const CHANNEL = {
  name: "Sung's family",
  handle: '@trend_insight_ssk',
  id: 'UCpApyAWoU3zcjBBkMKrqLKQ',
  url: 'https://www.youtube.com/@trend_insight_ssk',
};

// 채널 RSS에서 공개 영상 자동 수집 (최신 15개, 30분 캐시)
async function getChannelVideos() {
  try {
    const r = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL.id}`,
      { cf: { cacheTtl: 1800, cacheEverything: true } }
    );
    if (!r.ok) return [];
    const xml = await r.text();
    const out = [];
    const re = /<entry>[\s\S]*?<yt:videoId>([\w-]{11})<\/yt:videoId>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<published>([\d-]{10})/g;
    let m;
    while ((m = re.exec(xml))) {
      out.push({
        id: 'ch-' + m[1], vid: m[1],
        title: m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
        url: `https://youtu.be/${m[1]}`, date: m[3], source: 'channel',
      });
    }
    return out;
  } catch { return []; }
}

async function getVideos(env) {
  const obj = await env.PHOTOS.get(VIDEOS_KEY);
  if (!obj) return [];
  try { return await obj.json(); } catch { return []; }
}


// ===== 방학 체크 (연준·민준) — vacation.html 전용 =====
const VAC_WHO = ['연준', '민준'];
const VAC_TASKS = ['read','list','voca','gram','m38','mvoc','sci','wake','mmal','duA','duP','phon','exer'];
const VAC_FROM = '2026-07-26', VAC_TO = '2026-09-05';
const VAC_KEYCODE = 'c3ec484ccf17';
const vacKey = (who) => `meta/vacation-${who}.json`;

function vacHeaders(request) {
  const o = request.headers.get('origin');
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': o || '*',
    'access-control-allow-methods': 'GET,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
    'vary': 'origin',
  };
}
const vacRes = (request, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: vacHeaders(request) });

async function vacLoad(env, who) {
  const obj = await env.PHOTOS.get(vacKey(who));
  if (!obj) return {};
  try { return await obj.json(); } catch { return {}; }
}
async function vacLoadAll(env) {
  const out = {};
  await Promise.all(VAC_WHO.map(async (w) => { out[w] = await vacLoad(env, w); }));
  return out;
}
function vacValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= VAC_FROM && d <= VAC_TO;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    // ---- 이미지 서빙 (R2) ----
    if (p.startsWith('/img/')) {
      const key = decodeURIComponent(p.slice(5));
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set('cache-control', 'public, max-age=31536000, immutable');
      h.set('etag', obj.httpEtag);
      return new Response(obj.body, { headers: h });
    }

    if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);

    // ---- 앨범 목록 ----
    if (p === '/api/albums' && request.method === 'GET') {
      const list = await env.PHOTOS.list({ prefix: 'thumbs/', delimiter: '/' });
      const albums = [];
      for (const pre of list.delimitedPrefixes) {
        const name = pre.slice('thumbs/'.length, -1);
        const items = await env.PHOTOS.list({ prefix: pre, limit: 1000 });
        const sorted = items.objects.sort((a, b) => b.key.localeCompare(a.key));
        albums.push({
          name,
          count: items.objects.length + (items.truncated ? 1000 : 0),
          cover: sorted[0] ? sorted[0].key : null,
        });
      }
      albums.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      return ok(albums);
    }

    // ---- 앨범 내 사진 목록 ----
    if (p === '/api/photos' && request.method === 'GET') {
      const album = url.searchParams.get('album');
      if (!album) return err('album 필요');
      const out = [];
      let cursor;
      do {
        const list = await env.PHOTOS.list({
          prefix: `thumbs/${album}/`, cursor, limit: 500,
          include: ['customMetadata'],
        });
        for (const o of list.objects) {
          out.push({
            thumb: o.key,
            orig: (o.customMetadata && o.customMetadata.orig) || o.key,
            name: (o.customMetadata && o.customMetadata.name) || '',
            uploaded: o.uploaded,
          });
        }
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      out.sort((a, b) => b.thumb.localeCompare(a.thumb)); // 최신순
      return ok(out);
    }

    // ---- 사진 업로드 (원본 + 썸네일) ----
    if (p === '/api/upload' && request.method === 'POST') {
      const form = await request.formData();
      const album = (form.get('album') || '').toString().trim();
      const file = form.get('file');
      const thumb = form.get('thumb');
      if (!album || !file || typeof file === 'string') return err('album, file 필요');
      if (/[\/\\]/.test(album)) return err('앨범 이름에 / 사용 불가');

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const safeName = (file.name || 'photo').replace(/[^\w.\-가-힣 ]/g, '_');
      const origKey = `photos/${album}/${id}-${safeName}`;
      const thumbKey = `thumbs/${album}/${id}.webp`;

      await env.PHOTOS.put(origKey, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
      });
      const thumbBody = (thumb && typeof thumb !== 'string') ? thumb : file;
      await env.PHOTOS.put(thumbKey, thumbBody.stream(), {
        httpMetadata: { contentType: (thumb && thumb.type) || file.type || 'image/webp' },
        customMetadata: { orig: origKey, name: safeName },
      });
      return ok({ ok: true, orig: origKey, thumb: thumbKey });
    }

    // ---- 사진 삭제 ----
    if (p === '/api/photo' && request.method === 'DELETE') {
      const thumb = url.searchParams.get('thumb');
      const orig = url.searchParams.get('orig');
      if (!thumb) return err('thumb 필요');
      await env.PHOTOS.delete(thumb);
      if (orig) await env.PHOTOS.delete(orig);
      return ok({ ok: true });
    }

    // ---- 유튜브 영상 ----
    if (p === '/api/videos') {
      if (request.method === 'GET') {
        const [manual, channel] = await Promise.all([getVideos(env), getChannelVideos()]);
        const seen = new Set(manual.map(v => v.vid));
        const merged = manual.map(v => ({ ...v, source: v.source || 'manual' }))
          .concat(channel.filter(v => !seen.has(v.vid)));
        merged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        return ok({ channel: CHANNEL, videos: merged });
      }
      if (request.method === 'POST') {
        const body = await request.json();
        const { title, url: vurl } = body;
        const m = (vurl || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
        if (!m) return err('유튜브 링크를 인식하지 못했습니다');
        const videos = await getVideos(env);
        videos.unshift({
          id: `${Date.now()}`, vid: m[1],
          title: (title || '').toString().slice(0, 200) || '가족 영상',
          url: vurl, date: new Date().toISOString().slice(0, 10),
        });
        await env.PHOTOS.put(VIDEOS_KEY, JSON.stringify(videos), {
          httpMetadata: { contentType: 'application/json' },
        });
        return ok({ ok: true });
      }
      if (request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        const videos = (await getVideos(env)).filter(v => v.id !== id);
        await env.PHOTOS.put(VIDEOS_KEY, JSON.stringify(videos), {
          httpMetadata: { contentType: 'application/json' },
        });
        return ok({ ok: true });
      }
    }

    // ---- 방학 체크: 조회 / 저장 ----
    if (p === '/api/vacation') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: vacHeaders(request) });

      if (request.method === 'GET') {
        return vacRes(request, { ok: true, data: await vacLoadAll(env) });
      }

      if (request.method === 'PUT') {
        if (url.searchParams.get('k') !== VAC_KEYCODE) return vacRes(request, { error: 'bad key' }, 403);
        let body;
        try { body = await request.json(); } catch { return vacRes(request, { error: 'bad json' }, 400); }
        const who = body && body.who;
        if (!VAC_WHO.includes(who)) return vacRes(request, { error: 'bad who' }, 400);
        const ops = Array.isArray(body.ops) ? body.ops.slice(0, 600) : [];
        const doc = await vacLoad(env, who);
        let n = 0;
        for (const op of ops) {
          if (!op || !vacValidDate(op.d) || !VAC_TASKS.includes(op.t)) continue;
          if (op.v) { (doc[op.d] = doc[op.d] || {})[op.t] = 1; }
          else if (doc[op.d]) { delete doc[op.d][op.t]; if (!Object.keys(doc[op.d]).length) delete doc[op.d]; }
          n++;
        }
        if (n) {
          await env.PHOTOS.put(vacKey(who), JSON.stringify(doc), {
            httpMetadata: { contentType: 'application/json' },
          });
        }
        return vacRes(request, { ok: true, applied: n, data: doc });
      }
    }

    return err('Not found', 404);
  },
};
