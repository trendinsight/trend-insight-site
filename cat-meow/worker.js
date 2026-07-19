// 고양이 울음소리 아카이브 — Cloudflare Worker + R2
//
// 키 구조
//   clips/{id}.{ext}     원본 영상/오디오
//   thumbs/{id}.webp     포스터 프레임 (브라우저에서 생성)
//   meta/{id}.json       {id, name, uploaded_at, context, size, ext, analyzed}
//   analysis/{id}.json   분석 결과 (meow_analyze.py 산출물)
//   spec/{id}.png        스펙트로그램 이미지

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function listMeta(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.CLIPS.list({ prefix: "meta/", cursor, limit: 1000 });
    for (const o of res.objects) out.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    // ---------------------------------------------------------- 목록 조회
    if (p === "/api/clips" && request.method === "GET") {
      const keys = await listMeta(env);
      const items = [];
      for (const k of keys) {
        const obj = await env.CLIPS.get(k);
        if (!obj) continue;
        try { items.push(JSON.parse(await obj.text())); } catch (e) { /* skip */ }
      }
      items.sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || ""));
      return json({ count: items.length, items });
    }

    // ---------------------------------------------------------- 업로드
    // POST /api/upload  (multipart/form-data: file, thumb?, context?, recorded_at?)
    if (p === "/api/upload" && request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return json({ error: "file 없음" }, 400);

      const name = file.name || "clip.mp4";
      const ext = (name.split(".").pop() || "mp4").toLowerCase().slice(0, 5);
      const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
      const clipKey = `clips/${id}.${ext}`;

      await env.CLIPS.put(clipKey, file.stream(), {
        httpMetadata: { contentType: file.type || "video/mp4" },
      });

      const thumb = form.get("thumb");
      if (thumb && typeof thumb !== "string") {
        await env.CLIPS.put(`thumbs/${id}.webp`, thumb.stream(), {
          httpMetadata: { contentType: "image/webp" },
        });
      }

      const meta = {
        id,
        name,
        ext,
        clip_key: clipKey,
        size: file.size,
        context: (form.get("context") || "").toString().slice(0, 500),
        recorded_at: (form.get("recorded_at") || "").toString(),
        uploaded_at: new Date().toISOString(),
        analyzed: false,
      };
      await env.CLIPS.put(`meta/${id}.json`, JSON.stringify(meta), {
        httpMetadata: { contentType: "application/json" },
      });
      return json({ ok: true, meta });
    }

    // ---------------------------------------------------------- 분석 결과 저장/조회
    if (p === "/api/analysis") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id 필요" }, 400);

      if (request.method === "GET") {
        const obj = await env.CLIPS.get(`analysis/${id}.json`);
        if (!obj) return json({ error: "분석 결과 없음" }, 404);
        return new Response(obj.body, { headers: JSON_HEADERS });
      }

      if (request.method === "POST") {
        const body = await request.text();
        await env.CLIPS.put(`analysis/${id}.json`, body, {
          httpMetadata: { contentType: "application/json" },
        });
        const mo = await env.CLIPS.get(`meta/${id}.json`);
        if (mo) {
          const meta = JSON.parse(await mo.text());
          meta.analyzed = true;
          meta.analyzed_at = new Date().toISOString();
          try {
            const parsed = JSON.parse(body);
            meta.summary = parsed.summary || null;
            meta.top_type = parsed.top_type || null;
            meta.has_flag = !!(parsed.health_flags && parsed.health_flags.length);
          } catch (e) { /* ignore */ }
          await env.CLIPS.put(`meta/${id}.json`, JSON.stringify(meta), {
            httpMetadata: { contentType: "application/json" },
          });
        }
        return json({ ok: true });
      }
    }

    // ---------------------------------------------------------- 스펙트로그램 업로드
    if (p === "/api/spectrogram" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id 필요" }, 400);
      await env.CLIPS.put(`spec/${id}.png`, request.body, {
        httpMetadata: { contentType: "image/png" },
      });
      return json({ ok: true });
    }

    // ---------------------------------------------------------- 삭제
    if (p === "/api/clip" && request.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id 필요" }, 400);
      const mo = await env.CLIPS.get(`meta/${id}.json`);
      if (mo) {
        const meta = JSON.parse(await mo.text());
        if (meta.clip_key) await env.CLIPS.delete(meta.clip_key);
      }
      await Promise.all([
        env.CLIPS.delete(`meta/${id}.json`),
        env.CLIPS.delete(`thumbs/${id}.webp`),
        env.CLIPS.delete(`analysis/${id}.json`),
        env.CLIPS.delete(`spec/${id}.png`),
      ]);
      return json({ ok: true });
    }

    // ---------------------------------------------------------- 파일 서빙 (Range 지원)
    if (p.startsWith("/media/") || p.startsWith("/img/") || p.startsWith("/spec/")) {
      let key;
      if (p.startsWith("/media/")) key = decodeURIComponent(p.slice(7));
      else if (p.startsWith("/img/")) key = `thumbs/${decodeURIComponent(p.slice(5))}`;
      else key = `spec/${decodeURIComponent(p.slice(6))}`;

      const range = request.headers.get("range");
      const opts = {};
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const offset = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : undefined;
          opts.range = end !== undefined
            ? { offset, length: end - offset + 1 }
            : { offset };
        }
      }
      const obj = await env.CLIPS.get(key, opts);
      if (!obj) return new Response("Not found", { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("accept-ranges", "bytes");
      headers.set("cache-control", "public, max-age=31536000");
      if (obj.range && obj.size !== undefined) {
        const off = obj.range.offset || 0;
        const len = obj.range.length ?? (obj.size - off);
        headers.set("content-range", `bytes ${off}-${off + len - 1}/${obj.size}`);
        return new Response(obj.body, { status: 206, headers });
      }
      return new Response(obj.body, { headers });
    }

    // ---------------------------------------------------------- 정적 파일
    return env.ASSETS.fetch(request);
  },
};
