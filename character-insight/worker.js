// Character Insight - 인물 판별 사이트 Worker
// API: /api/persons, /api/assessments, /api/deep | 그 외는 정적 자산(public/)

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ---------- persons ----------
      if (path === "/api/persons") {
        if (method === "GET") {
          const { results } = await env.DB.prepare(
            `SELECT p.*, (SELECT COUNT(*) FROM assessments a WHERE a.person_id = p.id) AS n_assess,
                    (SELECT COUNT(*) FROM deep_reports d WHERE d.person_id = p.id) AS n_deep,
                    (SELECT COUNT(*) FROM incidents i WHERE i.person_id = p.id) AS n_inc,
                    (SELECT total FROM assessments a WHERE a.person_id = p.id ORDER BY id DESC LIMIT 1) AS last_total,
                    (SELECT verdict FROM assessments a WHERE a.person_id = p.id ORDER BY id DESC LIMIT 1) AS last_verdict,
                    (SELECT created_at FROM assessments a WHERE a.person_id = p.id ORDER BY id DESC LIMIT 1) AS last_at
             FROM persons p ORDER BY p.id DESC`
          ).all();
          return json(results);
        }
        if (method === "POST") {
          const b = await request.json();
          if (!b.name) return json({ error: "name required" }, 400);
          const r = await env.DB.prepare(
            "INSERT INTO persons (name, relation, memo) VALUES (?, ?, ?)"
          ).bind(b.name, b.relation || "", b.memo || "").run();
          return json({ ok: true, id: r.meta.last_row_id });
        }
        if (method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ error: "id required" }, 400);
          await env.DB.prepare("DELETE FROM assessments WHERE person_id = ?").bind(id).run();
          await env.DB.prepare("DELETE FROM deep_reports WHERE person_id = ?").bind(id).run();
          await env.DB.prepare("DELETE FROM incidents WHERE person_id = ?").bind(id).run();
          await env.DB.prepare("DELETE FROM persons WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }
      }

      // ---------- assessments ----------
      if (path === "/api/assessments") {
        if (method === "GET") {
          const pid = url.searchParams.get("person_id");
          if (!pid) return json({ error: "person_id required" }, 400);
          const { results } = await env.DB.prepare(
            "SELECT * FROM assessments WHERE person_id = ? ORDER BY id ASC"
          ).bind(pid).all();
          return json(results);
        }
        if (method === "POST") {
          const b = await request.json();
          if (!b.person_id || !b.answers || b.total == null)
            return json({ error: "person_id, answers, total required" }, 400);
          const r = await env.DB.prepare(
            `INSERT INTO assessments (person_id, mode, answers_json, traits_json, dims_json, total, verdict, flags_json, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            b.person_id, b.mode || "other",
            JSON.stringify(b.answers), JSON.stringify(b.traits || {}), JSON.stringify(b.dims || {}),
            b.total, b.verdict || "", JSON.stringify(b.flags || []), b.note || ""
          ).run();
          return json({ ok: true, id: r.meta.last_row_id });
        }
        if (method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ error: "id required" }, 400);
          await env.DB.prepare("DELETE FROM assessments WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }
      }


      // ---------- incidents (행동 관찰 기록) ----------
      if (path === "/api/incidents") {
        if (method === "GET") {
          const pid = url.searchParams.get("person_id");
          const pending = url.searchParams.get("pending");
          if (pending === "1") {
            const { results } = await env.DB.prepare(
              `SELECT i.*, p.name AS person_name FROM incidents i JOIN persons p ON p.id = i.person_id
               WHERE i.judged = 0 ORDER BY i.id ASC`
            ).all();
            return json(results);
          }
          if (!pid) return json({ error: "person_id required" }, 400);
          const { results } = await env.DB.prepare(
            "SELECT * FROM incidents WHERE person_id = ? ORDER BY id DESC"
          ).bind(pid).all();
          return json(results);
        }
        if (method === "POST") {
          const b = await request.json();
          if (!b.person_id) return json({ error: "person_id required" }, 400);
          const r = await env.DB.prepare(
            `INSERT INTO incidents (person_id, kind, situation, response, text, traits_json, comment, judged, happened_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            b.person_id, b.kind || "card", b.situation || "", b.response || "", b.text || "",
            JSON.stringify(b.traits || {}), b.comment || "",
            b.judged == null ? (b.kind === "free" ? 0 : 1) : b.judged, b.happened_at || ""
          ).run();
          return json({ ok: true, id: r.meta.last_row_id });
        }
        if (method === "PATCH" || method === "PUT") {
          const b = await request.json();
          if (!b.id) return json({ error: "id required" }, 400);
          await env.DB.prepare(
            "UPDATE incidents SET traits_json = ?, comment = ?, judged = 1 WHERE id = ?"
          ).bind(JSON.stringify(b.traits || {}), b.comment || "", b.id).run();
          return json({ ok: true });
        }
        if (method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ error: "id required" }, 400);
          await env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }
      }

      // ---------- deep reports (클로드 심층 판정 리포트) ----------
      if (path === "/api/deep") {
        if (method === "GET") {
          const pid = url.searchParams.get("person_id");
          const id = url.searchParams.get("id");
          if (id) {
            const row = await env.DB.prepare("SELECT * FROM deep_reports WHERE id = ?").bind(id).first();
            return json(row || {});
          }
          if (!pid) return json({ error: "person_id required" }, 400);
          const { results } = await env.DB.prepare(
            "SELECT id, person_id, title, created_at FROM deep_reports WHERE person_id = ? ORDER BY id DESC"
          ).bind(pid).all();
          return json(results);
        }
        if (method === "POST") {
          const b = await request.json();
          if (!b.person_id || !b.title || !b.html)
            return json({ error: "person_id, title, html required" }, 400);
          const r = await env.DB.prepare(
            "INSERT INTO deep_reports (person_id, title, html) VALUES (?, ?, ?)"
          ).bind(b.person_id, b.title, b.html).run();
          return json({ ok: true, id: r.meta.last_row_id });
        }
        if (method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ error: "id required" }, 400);
          await env.DB.prepare("DELETE FROM deep_reports WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }
      }

      if (path.startsWith("/api/")) return json({ error: "not found" }, 404);

      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
