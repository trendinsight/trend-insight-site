// cat-meow Worker — 업로드 즉시 분석 트리거 포함본
// 변경점: (1) fetch 에 ctx 추가  (2) triggerAnalysis 헬퍼 추가
//         (3) /api/upload 성공 직후 GitHub Actions 로 즉시 분석 신호 전송
// 안전장치: GH_TOKEN/GH_OWNER/GH_REPO 시크릿이 없으면 아무 일도 안 하고 넘어감(업로드 정상 동작).

var JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function listMeta(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.CLIPS.list({ prefix: "meta/", cursor, limit: 1e3 });
    for (const o of res.objects) out.push(o.key);
    cursor = res.truncated ? res.cursor : void 0;
  } while (cursor);
  return out;
}

// ── 즉시 분석 트리거: GitHub Actions repository_dispatch 호출 ──
// 시크릿이 하나라도 없으면 조용히 건너뜀(업로드는 절대 실패하지 않음).
async function triggerAnalysis(env, clipId) {
  if (!env.GH_OWNER || !env.GH_REPO || !env.GH_TOKEN) return; // 미설정 시 무시
  try {
    const res = await fetch(
      `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GH_TOKEN}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "cat-meow-worker",
        },
        body: JSON.stringify({
          event_type: "new-clip",
          client_payload: { clip_id: clipId },
        }),
      }
    );
    if (!res.ok) console.log("dispatch 실패:", res.status, await res.text());
  } catch (e) {
    console.log("dispatch 예외:", e && e.message);
  }
}

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/clips" && request.method === "GET") {
      const keys = await listMeta(env);
      const items = [];
      for (const k of keys) {
        const obj = await env.CLIPS.get(k);
        if (!obj) continue;
        try {
          items.push(JSON.parse(await obj.text()));
        } catch (e) {}
      }
      items.sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || ""));
      return json({ count: items.length, items });
    }

    if (p === "/api/upload" && request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return json({ error: "file \uC5C6\uC74C" }, 400);
      const name = file.name || "clip.mp4";
      const ext = (name.split(".").pop() || "mp4").toLowerCase().slice(0, 5);
      const id = `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
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
        uploaded_at: (/* @__PURE__ */ new Date()).toISOString(),
        analyzed: false,
      };
      await env.CLIPS.put(`meta/${id}.json`, JSON.stringify(meta), {
        httpMetadata: { contentType: "application/json" },
      });

      // ★ 업로드 성공 직후 즉시 분석 신호(응답은 기다리지 않음)
      ctx.waitUntil(triggerAnalysis(env, id));

      return json({ ok: true, meta });
    }

    if (p === "/api/analysis") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id \uD544\uC694" }, 400);
      if (request.method === "GET") {
        const obj = await env.CLIPS.get(`analysis/${id}.json`);
        if (!obj) return json({ error: "\uBD84\uC11D \uACB0\uACFC \uC5C6\uC74C" }, 404);
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
          meta.analyzed_at = (/* @__PURE__ */ new Date()).toISOString();
          try {
            const parsed = JSON.parse(body);
            meta.summary = parsed.summary || null;
            meta.top_type = parsed.top_type || null;
            meta.has_flag = !!(parsed.health_flags && parsed.health_flags.length);
          } catch (e) {}
          await env.CLIPS.put(`meta/${id}.json`, JSON.stringify(meta), {
            httpMetadata: { contentType: "application/json" },
          });
        }
        return json({ ok: true });
      }
    }

    if (p === "/api/spectrogram" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id \uD544\uC694" }, 400);
      await env.CLIPS.put(`spec/${id}.png`, request.body, {
        httpMetadata: { contentType: "image/png" },
      });
      return json({ ok: true });
    }

    if (p === "/api/clip" && request.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id \uD544\uC694" }, 400);
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
          const end = m[2] ? parseInt(m[2], 10) : void 0;
          opts.range = end !== void 0 ? { offset, length: end - offset + 1 } : { offset };
        }
      }
      const obj = await env.CLIPS.get(key, opts);
      if (!obj) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("accept-ranges", "bytes");
      headers.set("cache-control", "public, max-age=31536000");
      if (obj.range && obj.size !== void 0) {
        const off = obj.range.offset || 0;
        const len = obj.range.length ?? obj.size - off;
        headers.set("content-range", `bytes ${off}-${off + len - 1}/${obj.size}`);
        return new Response(obj.body, { status: 206, headers });
      }
      return new Response(obj.body, { headers });
    }

    return env.ASSETS.fetch(request);
  },
};

export {
  worker_default as default,
};
