/* Trend Insight 공용 위젯 (3단계, 2026-10-02)
 * ─ 종목 즉석 조회 패널  : TI.stock(el, code) / TI.stockModal(code)   ← /api/stock/{code}
 * ─ 메모·댓글            : TI.comments(el, target)                   ← /api/comments
 * ─ SOTP 부품표 서버 동기화: TISotpSync.pull(code) / push(code, name)  ← /api/user/sotp
 * ─ 자동 부착: 보드·도구 페이지 하단에 페이지 메모, 매물대·SOTP 페이지에는 종목이 바뀔 때마다 종목 패널
 * 워커가 대상 페이지 <head>에 자동 주입하며, 직접 <script src="/ti-widgets.js">로 넣어도 된다(중복 로드 방지).
 */
(function () {
  if (window.TI) return;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, d = 0) => n == null || isNaN(n) ? "—" : Number(n).toLocaleString("ko-KR", { maximumFractionDigits: d });
  const sg = n => n == null ? "—" : `<span class="${n > 0 ? "ti-up" : n < 0 ? "ti-dn" : ""}">${n > 0 ? "+" : ""}${fmt(n, 1)}%</span>`;
  const sq = n => n == null ? "—" : `<span class="${n > 0 ? "ti-up" : n < 0 ? "ti-dn" : ""}">${n > 0 ? "+" : ""}${fmt(n)}</span>`;
  async function api(path, opt) {
    const r = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store" }, opt || {}));
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!j) throw new Error("응답 오류 (" + r.status + ")");
    if (!j.ok) { const e = new Error(j.error || "오류"); e.status = r.status; throw e; }
    return j;
  }

  /* ── 스타일 (페이지 테마 변수 없을 때도 동작) ── */
  const css = `
  .ti-w{--tw-card:#fff;--tw-line:#e4e9f1;--tw-soft:#f5f7fb;--tw-text:#1c2533;--tw-mut:#5b6779;--tw-navy:#0b1f3f;--tw-acc:#2e6ff2;
    font-family:'Pretendard',-apple-system,sans-serif;color:var(--tw-text);line-height:1.55;font-size:14px}
  html[data-theme=dark] .ti-w{--tw-card:#16223a;--tw-line:#26334d;--tw-soft:#111a2e;--tw-text:#d4deee;--tw-mut:#8fa0b9;--tw-navy:#e8effc}
  .ti-w .ti-box{background:var(--tw-card);border:1px solid var(--tw-line);border-radius:12px;padding:14px 16px;margin:14px 0}
  .ti-w h3{font-size:1rem;color:var(--tw-navy);margin:0 0 8px;display:flex;justify-content:space-between;gap:8px;align-items:baseline}
  .ti-w h4{font-size:.86rem;color:var(--tw-navy);margin:12px 0 6px}
  .ti-w small,.ti-w .ti-mut{color:var(--tw-mut)}
  .ti-up{color:#d6336c}.ti-dn{color:#1c7ed6}
  html[data-theme=dark] .ti-up{color:#ff6b8b}html[data-theme=dark] .ti-dn{color:#5aa9ff}
  .ti-w .ti-kv{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 12px;font-size:.82rem}
  .ti-w .ti-kv span{display:block;color:var(--tw-mut);font-size:.72rem}
  .ti-w table{width:100%;border-collapse:collapse;font-size:.8rem}.ti-w td,.ti-w th{padding:4px 6px;border-bottom:1px solid var(--tw-line);text-align:right;white-space:nowrap}
  .ti-w td:first-child,.ti-w th:first-child{text-align:left}.ti-w th{color:var(--tw-mut);font-weight:600}
  .ti-w .ti-tag{display:inline-block;font-size:.7rem;padding:1px 7px;border-radius:6px;background:var(--tw-soft);color:var(--tw-mut);margin-left:4px}
  .ti-w .ti-tag.r{background:#ffe3e3;color:#c92a2a}
  .ti-w a{color:inherit;text-decoration:underline}
  .ti-w textarea{width:100%;min-height:64px;font:inherit;padding:8px 10px;border:1px solid var(--tw-line);border-radius:8px;background:var(--tw-card);color:var(--tw-text);resize:vertical;box-sizing:border-box}
  .ti-w button{font:inherit;font-size:.82rem;padding:6px 12px;border-radius:8px;border:1px solid var(--tw-acc);background:var(--tw-acc);color:#fff;cursor:pointer}
  .ti-w button.ti-ghost{background:transparent;color:var(--tw-acc)}
  .ti-w .ti-cm{padding:8px 0;border-bottom:1px dashed var(--tw-line);font-size:.86rem;white-space:pre-wrap;word-break:break-word}
  .ti-w .ti-cm b{color:var(--tw-navy)}
  .ti-w .ti-del{border:0;background:none;color:var(--tw-mut);padding:0 4px;font-size:.75rem;cursor:pointer}
  .ti-w .ti-help{font-size:.78rem;color:var(--tw-mut);background:var(--tw-soft);border-radius:8px;padding:8px 10px;margin-top:10px}
  .ti-modal{position:fixed;inset:0;background:rgba(5,12,28,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}
  .ti-modal>.ti-w{width:min(820px,100%);background:var(--tw-soft);border-radius:14px;padding:6px 14px 14px;position:relative}
  .ti-modal .ti-x{position:absolute;right:10px;top:8px;background:none;border:0;font-size:22px;color:var(--tw-mut);cursor:pointer}
  @media(max-width:600px){.ti-w .ti-kv{grid-template-columns:repeat(2,1fr)}}`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  /* ── 메모·댓글 ── */
  async function comments(el, target, opts) {
    opts = opts || {};
    el.classList.add("ti-w");
    const title = opts.title || "메모·댓글";
    el.innerHTML = `<div class="ti-box"><h3><span>💬 ${esc(title)}</span><small>${esc(target)}</small></h3><div class="ti-list ti-mut">불러오는 중…</div></div>`;
    const box = el.querySelector(".ti-box"), list = el.querySelector(".ti-list");
    let data;
    try { data = await api("/api/comments?target=" + encodeURIComponent(target)); }
    catch (e) { list.innerHTML = e.status === 401 ? `로그인하면 메모를 보고 남길 수 있습니다. <a href="/login.html?next=${encodeURIComponent(location.pathname + location.search)}">로그인</a>` : esc(e.message); return; }
    const draw = () => {
      list.className = "ti-list";
      list.innerHTML = data.items.length ? data.items.map(c => `<div class="ti-cm"><b>${esc(c.name)}</b> <small>${esc(new Date(c.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }))}</small>
        ${(c.mine || data.owner) ? `<button class="ti-del" data-id="${c.id}">삭제</button>` : ""}<div>${esc(c.body)}</div></div>`).join("")
        : `<div class="ti-mut" style="font-size:.85rem">아직 메모가 없습니다.</div>`;
      list.querySelectorAll(".ti-del").forEach(b => b.onclick = async () => {
        if (!confirm("이 메모를 삭제할까요?")) return;
        try { await api("/api/comments/" + b.dataset.id, { method: "DELETE" }); data.items = data.items.filter(x => String(x.id) !== b.dataset.id); draw(); }
        catch (e) { alert(e.message); }
      });
    };
    draw();
    const form = document.createElement("div");
    form.innerHTML = `<textarea maxlength="1000" placeholder="메모를 남기세요 (최대 1000자 · 로그인 회원에게 공개)"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><small class="ti-cnt">0/1000</small><button>남기기</button></div>
      <div class="ti-help">로그인한 회원끼리 공유되는 메모입니다. 본인 글은 직접 삭제할 수 있고 운영자는 모든 글을 관리할 수 있습니다. 다른 회원이 글을 남기면 운영자에게 텔레그램 알림이 갑니다. 10분에 15개까지 작성할 수 있습니다.</div>`;
    box.appendChild(form);
    const ta = form.querySelector("textarea"), cnt = form.querySelector(".ti-cnt"), btn = form.querySelector("button");
    ta.oninput = () => cnt.textContent = ta.value.length + "/1000";
    btn.onclick = async () => {
      const body = ta.value.trim(); if (!body) return;
      btn.disabled = true;
      try {
        const r = await api("/api/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, body }) });
        data.items.unshift({ id: r.id, name: "나", body, created_at: r.created_at, mine: true }); ta.value = ""; cnt.textContent = "0/1000"; draw();
      } catch (e) { alert(e.message); } finally { btn.disabled = false; }
    };
  }

  /* ── 종목 즉석 조회 패널 ── */
  function stockHtml(o) {
    const v = o.val || {}, c = o.consensus || {}, vp = o.vp || {}, t = o.thesis;
    const flows = o.flows && o.flows.days && o.flows.days.length ? `<h4>수급 (${esc(o.flows.source)}, 주)</h4><table><tr><th>일자</th><th>외국인</th><th>기관계</th><th>개인</th></tr>
      ${o.flows.days.slice(-5).map(d => `<tr><td>${String(d.date).slice(4, 6)}/${String(d.date).slice(6)}</td><td>${sq(d.외국인)}</td><td>${sq(d.기관계)}</td><td>${sq(d.개인)}</td></tr>`).join("")}
      <tr><td><b>5일 합</b></td><td><b>${sq(o.flows.sum5 && o.flows.sum5.외국인)}</b></td><td><b>${sq(o.flows.sum5 && o.flows.sum5.기관계)}</b></td><td><b>${sq(o.flows.sum5 && o.flows.sum5.개인)}</b></td></tr></table>` : "";
    const lv = x => x ? `${fmt(x.low)}~${fmt(x.high)}${x.grade ? ` <small>${x.grade}</small>` : ""}` : "—";
    const vph = vp.verdict ? `<h4>매물대 (서버 계산 · 최근 750봉)</h4><div class="ti-kv">
      <div><span>판정</span><b>${esc(vp.label)}</b></div><div><span>아래 매물 비중</span>${fmt(vp.pct_below, 1)}%</div>
      <div><span>1차 저항</span>${lv(vp.levels && vp.levels.r1)}</div><div><span>1차 지지</span>${lv(vp.levels && vp.levels.s1)}</div></div>
      ${vp.reason ? `<div class="ti-mut" style="font-size:.8rem;margin-top:4px">${esc(vp.reason)}</div>` : ""}
      <div class="ti-mut" style="font-size:.78rem;margin-top:4px">추세 지표 일치도: ${esc(vp.reliability || "—")} · <a href="/volume-profile.html?code=${o.code}">매물대 차트로 보기</a></div>` : "";
    const dart = o.dart && o.dart.items ? `<h4>최근 30일 공시 (DART)</h4>${o.dart.items.length ? o.dart.items.slice(0, 10).map(d => `<div style="font-size:.82rem">${d.risky ? "🔴" : "📄"} ${String(d.date).slice(4, 6)}/${String(d.date).slice(6)} <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a>${d.flags.map(f => `<span class="ti-tag ${d.risky ? "r" : ""}">${esc(f)}</span>`).join("")}</div>`).join("") : `<div class="ti-mut" style="font-size:.82rem">최근 30일 공시 없음</div>`}` : "";
    return `<h3><span>${esc(o.name || o.code)} <small>${o.code}${o.market ? " · " + o.market : ""}</small></span>
        <small>${o.cached ? "캐시" : "새로 조회"} · ${esc(new Date(o.updated).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }))}</small></h3>
      <div style="font-size:1.3rem;font-weight:800">${fmt(o.close)}원 ${sg(o.chg_pct)} <small style="font-weight:500">${esc(o.date || "")} 기준 · ${esc(o.trend || "")}</small></div>
      <div class="ti-kv" style="margin-top:8px">
        <div><span>52주 고점 대비</span>${sg(o.from_hi52_pct)}</div><div><span>52주 저점 대비</span>${sg(o.from_lo52_pct)}</div>
        <div><span>거래량/20일 평균</span>${o.vol_ratio20 != null ? fmt(o.vol_ratio20, 2) + "배" : "—"}</div><div><span>MA20 / MA60</span>${fmt(o.ma20)} / ${fmt(o.ma60)}</div>
        <div><span>PER (추정)</span>${fmt(v.per, 1)} (${fmt(v.cns_per, 1)})</div><div><span>PBR · 배당</span>${fmt(v.pbr, 2)} · ${v.div_yield != null ? fmt(v.div_yield, 2) + "%" : "—"}</div>
        <div><span>컨센서스 목표가</span>${fmt(c.target)} ${c.upside_pct != null ? "(" + sg(c.upside_pct) + ")" : ""}</div><div><span>시가총액 · 외인</span>${esc(v.mcap || "—")} · ${v.foreign_rate != null ? fmt(v.foreign_rate, 1) + "%" : "—"}</div>
      </div>
      ${t ? `<div class="ti-help" style="margin-top:8px">📌 논거 보드 <b>${esc(t.status)}</b> · 목표 ${fmt(t.target)} (${sg(t.to_target_pct)}) · 손절 ${fmt(t.stop)} (여유 ${sg(t.to_stop_pct)})</div>` : ""}
      ${vph}${flows}${dart}
      ${o.price_check === "불일치" ? `<div class="ti-mut" style="font-size:.78rem">⚠️ 야후 종가 ${fmt(o.yahoo_close)}와 불일치 — 원천 확인 필요</div>` : ""}
      ${(o.research || []).length ? `<div class="ti-mut" style="font-size:.78rem;margin-top:6px">최근 리서치: ${o.research.map(r => esc(r.broker + " — " + r.title)).join(" / ")}</div>` : ""}
      ${o.collected ? `<div class="ti-mut" style="font-size:.78rem">서버 자동 수집 대상(${esc(o.collected.ymd)})</div>` : ""}
      <div class="ti-help">출처: 네이버 증권(시세·밸류·컨센서스·수급) · 야후(종가 교차검증) · DART(공시) · 서버 매물대 계산. 같은 종목은 장중 10분·장 마감 후 6시간 동안 저장된 결과를 다시 씁니다. 투자 권유가 아닙니다.</div>
      <div style="margin-top:8px;display:flex;gap:6px"><button class="ti-ghost ti-refresh">새로 조회</button></div>`;
  }
  async function stock(el, code, opts) {
    opts = opts || {};
    el.classList.add("ti-w");
    el.innerHTML = `<div class="ti-box ti-mut">${esc(code)} 조회 중…</div><div class="ti-cmts"></div>`;
    const box = el.querySelector(".ti-box");
    const go = async (fresh) => {
      try {
        const j = await api(`/api/stock/${encodeURIComponent(code)}${fresh ? "?fresh=1" : ""}`);
        box.className = "ti-box"; box.innerHTML = stockHtml(j.data);
        box.querySelector(".ti-refresh").onclick = () => { box.classList.add("ti-mut"); go(true); };
      } catch (e) {
        box.innerHTML = e.status === 401 ? `종목 조회는 로그인 후 이용할 수 있습니다. <a href="/login.html?next=${encodeURIComponent(location.pathname + location.search)}">로그인</a>` : esc(e.message);
      }
    };
    await go(false);
    if (opts.comments !== false) comments(el.querySelector(".ti-cmts"), "stock:" + code, { title: "이 종목 메모" });
  }
  function stockModal(code) {
    const m = document.createElement("div"); m.className = "ti-modal";
    m.innerHTML = `<div class="ti-w"><button class="ti-x" aria-label="닫기">×</button><div class="ti-body"></div></div>`;
    const close = () => m.remove();
    m.onclick = e => { if (e.target === m) close(); };
    m.querySelector(".ti-x").onclick = close;
    document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
    document.body.appendChild(m);
    stock(m.querySelector(".ti-body"), code);
  }

  /* ── SOTP 부품표 서버 동기화 ── */
  const SOTP = {
    meta: c => { try { return JSON.parse(localStorage.getItem("sotp-meta:" + c) || "{}"); } catch (e) { return {}; } },
    setMeta: (c, m) => { try { localStorage.setItem("sotp-meta:" + c, JSON.stringify(m)); } catch (e) {} },
    status(msg) {
      let b = document.getElementById("ti-sotp-status");
      if (!b) { b = document.createElement("div"); b.id = "ti-sotp-status";
        b.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9000;font:12px Pretendard,sans-serif;background:rgba(11,31,63,.88);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer";
        b.title = "내 서버 저장 부품표 목록"; b.onclick = () => SOTP.list(); document.body.appendChild(b); }
      b.textContent = msg;
    },
    // 서버 사본이 더 최신이면 localStorage에 덮어써서 페이지의 restore()가 그것을 읽게 한다
    async pull(code) {
      try {
        const j = await api("/api/user/sotp/" + code);
        if (!j.item) { this.status("☁ 서버 저장본 없음 — 수정하면 자동 저장"); return false; }
        const local = this.meta(code).saved_at || "";
        if (j.item.saved_at > local || !localStorage.getItem("sotp:" + code)) {
          localStorage.setItem("sotp:" + code, JSON.stringify(j.item.data));
          this.setMeta(code, { saved_at: j.item.saved_at });
          this.status("☁ 서버 저장본 불러옴 · " + new Date(j.item.saved_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
          return true;
        }
        this.status("☁ 이 기기 저장본이 최신");
      } catch (e) { this.status(e.status === 401 ? "☁ 로그인하면 부품표가 서버에 저장됩니다" : "☁ 서버 연결 실패 — 이 기기에만 저장"); }
      return false;
    },
    _t: null,
    push(code, name) {
      clearTimeout(this._t);
      this._t = setTimeout(async () => {
        const raw = localStorage.getItem("sotp:" + code); if (!raw) return;
        const savedAt = new Date().toISOString();
        try {
          await api("/api/user/sotp/" + code, { method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name || "", saved_at: savedAt, data: JSON.parse(raw) }) });
          this.setMeta(code, { saved_at: savedAt });
          this.status("☁ 서버 저장 " + new Date(savedAt).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" }));
        } catch (e) { this.status(e.status === 401 ? "☁ 로그인하면 서버에 저장됩니다" : "☁ 서버 저장 실패 — 이 기기에는 저장됨"); }
      }, 1500);
    },
    async list() {
      try {
        const j = await api("/api/user/sotp");
        const m = document.createElement("div"); m.className = "ti-modal";
        m.innerHTML = `<div class="ti-w"><button class="ti-x">×</button><div class="ti-box"><h3>☁ 내 SOTP 부품표 (${j.items.length})</h3>
          ${j.items.length ? j.items.map(x => `<div class="ti-cm"><a href="/sotp.html?code=${x.code}">${esc(x.name || x.code)} <small>${x.code}</small></a>
            <small style="float:right">${esc(new Date(x.saved_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }))}</small></div>`).join("") : '<div class="ti-mut">저장된 부품표가 없습니다.</div>'}
          <div class="ti-help">부품표는 수정할 때마다 1.5초 뒤 계정에 자동 저장됩니다. 다른 기기에서 같은 종목을 열면 더 최신 저장본을 자동으로 불러옵니다. 계정당 100종목까지.</div></div></div>`;
        m.onclick = e => { if (e.target === m) m.remove(); }; m.querySelector(".ti-x").onclick = () => m.remove();
        document.body.appendChild(m);
      } catch (e) { alert(e.message); }
    },
  };

  window.TI = { stock, stockModal, comments, api, esc };
  window.TISotpSync = SOTP;

  /* ── 자동 부착 ── */
  const page = (location.pathname.split("/").pop() || "index").replace(/\.html$/, "") || "index";
  const host = () => document.querySelector(".wrap") || document.querySelector("main") || document.body;
  function mount() {
    // 종목형 페이지: ?code= 가 바뀔 때마다 종목 패널(즉석 조회 + 종목 메모)
    if (page === "volume-profile" || page === "sotp") {
      let last = null;
      const panel = document.createElement("div"); panel.id = "ti-stock-panel"; panel.style.cssText = "max-width:1080px;margin:0 auto;padding:0 16px";
      host().appendChild(panel);
      const check = () => {
        const c = new URLSearchParams(location.search).get("code");
        if (c && c !== last) { last = c; stock(panel, c); }
      };
      ["pushState", "replaceState"].forEach(fn => { const o = history[fn]; history[fn] = function () { const r = o.apply(this, arguments); setTimeout(check, 0); return r; }; });
      window.addEventListener("popstate", check);
      check();
    }
    // 보드·도구 페이지: 하단에 페이지 메모
    if (!document.querySelector("[data-ti-comments]") && page !== "index" && !/^(login|signup|terms|volume-profile|sotp)$/.test(page)) {
      const box = document.createElement("div"); box.style.cssText = "max-width:1080px;margin:0 auto;padding:0 16px 40px";
      host().appendChild(box);
      comments(box, "page:" + page.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60), { title: "이 페이지 메모" });
    }
    document.querySelectorAll("[data-ti-comments]").forEach(el => comments(el, el.dataset.tiComments));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
