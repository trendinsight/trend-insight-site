/* Trend Insight — 전체 스킬 3부 실행 위젯
   <div id="skillrun-box" data-mode="compact|full"></div> 에 렌더링.
   버튼: 📋 실행 문구 복사(Claude 데스크톱에 붙여넣기) / 📨 실행 요청(KV 큐 + 텔레그램 알림)
   상태: /data/skillrun-status.json(마지막 실행 결과) + /api/skillrun/requests(대기 요청) */
(function () {
  var PARTS = [
    { n: 1, icon: '🌤', name: '1부 · 환경', cmd: '전체 스킬 1부', count: '16개 스킬',
      desc: '시장의 날씨를 잽니다. 온도계(시장·거시·군중·볼밴·선물·코인)와 금리·자금흐름·하락장 국면으로 오늘의 게이트(GREEN/YELLOW/RED)와 권장 예수금을 정합니다.',
      skills: ['데일리 브리핑', '마켓 캘린더', '시장 온도계', '거시 온도계', '군중심리 온도계', '볼린저 온도계', '선물 베이시스', '코인 온도계', '예수금 온도계', '금리 예측', '거시 분석', '스타일 로테이션', '돈의 흐름', '하락장 레이더', '레버리지 스위치', '브라질 국채'] },
    { n: 2, icon: '🧭', name: '2부 · 수급·발굴', cmd: '전체 스킬 2부', count: '20개 스킬',
      desc: '돈이 어디로 몰리는지 봅니다. 업종 수급·신고가·산업지표를 훑고, 스크리너 8종(CANSLIM·피셔·고레가와 등)의 교집합 Top 3에 진입 판정을 붙입니다.',
      skills: ['리서치 다이제스트', '리포트 요약 큐', '업종 수급', '주간 수급 레이더', '52주 신고가', '산업지표', '수출 펄스', '한국주식 스크리너', 'CANSLIM', '배당 복리', '기간별 종목', '피셔 스크린', '고레가와', 'SA 컨빅션', '밸류체인 면접', 'LTCM 수렴', '숏 후보', '크립토 분석', '오늘의 격언', '진입 타이머'] },
    { n: 3, icon: '🛡', name: '3부 · 보유종목·결재', cmd: '전체 스킬 3부', count: '포트 크기에 비례',
      desc: '내 계좌를 점검합니다. 보유 전 종목의 손절·과열·상관·리스크·논거를 보고, 상위 종목 매트릭스와 1종목 심층분석을 거쳐 팀장·공명 결재와 종합 보고서를 만듭니다.',
      skills: ['포트폴리오', '손절 레이더', '과열 경보', '상관 리스크', '리스크 계기판', '논거 점검', '보유종목 매트릭스(8종)', '심층 로테이션(5종)', '매매일지', '성과 귀인', '피라미드 계산', '팀장 결재', '공명 책략', '종목 그래프', '볼트 점검', '종합 보고'] }
  ];

  var css = '' +
    '.sr-wrap{margin-top:30px}' +
    '.sr-head{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px}' +
    '.sr-head h3{font-size:1.1rem;font-weight:800;color:var(--navy);margin:0}' +
    '.sr-head .sr-sub{font-size:.8rem;color:var(--muted)}' +
    '.sr-head a{font-size:.8rem;font-weight:700;color:var(--accent);text-decoration:none}' +
    '.sr-list{display:flex;flex-direction:column;gap:10px}' +
    '.sr-row{display:grid;grid-template-columns:minmax(150px,190px) 1fr;gap:14px;align-items:start;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}' +
    '.sr-left{display:flex;flex-direction:column;gap:7px}' +
    '.sr-name{font-weight:800;color:var(--navy);font-size:1rem}' +
    '.sr-count{font-size:.74rem;color:var(--muted);font-weight:600}' +
    '.sr-btn{font-family:inherit;font-size:.8rem;font-weight:700;border-radius:999px;padding:8px 12px;cursor:pointer;border:1px solid var(--accent);transition:transform .12s,background .15s;text-align:center;white-space:nowrap}' +
    '.sr-btn:hover{transform:translateY(-1px)}' +
    '.sr-btn.req{background:var(--accent);color:#fff}' +
    '.sr-btn.req:hover{background:var(--accent-2,#1e5ae0)}' +
    '.sr-btn.copy{background:transparent;color:var(--accent)}' +
    '.sr-btn:disabled{opacity:.55;cursor:default;transform:none}' +
    '.sr-desc{font-size:.88rem;line-height:1.6;color:var(--text);margin:0}' +
    '.sr-last{margin-top:8px;font-size:.8rem;color:var(--muted);line-height:1.5}' +
    '.sr-last b{color:var(--navy)}' +
    '.sr-chip{display:inline-block;font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:999px;margin-right:4px}' +
    '.sr-ok{background:#e3f4ea;color:#1d7a46}.sr-pa{background:#fff3dc;color:#9a6a00}.sr-sk{background:#eef1f6;color:#5b6779}.sr-fa{background:#fde8e8;color:#b22f2f}' +
    'html[data-theme=dark] .sr-ok{background:#16352a;color:#7fd4a2}html[data-theme=dark] .sr-pa{background:#3b2c14;color:#ffc069}html[data-theme=dark] .sr-sk{background:#233048;color:#aebdd6}html[data-theme=dark] .sr-fa{background:#3d1f1f;color:#ff9e94}' +
    '.sr-q{margin-top:6px;font-size:.78rem;font-weight:700;color:#9a6a00}' +
    'html[data-theme=dark] .sr-q{color:#ffc069}' +
    '.sr-q button{font:inherit;font-size:.74rem;background:none;border:none;color:var(--muted);text-decoration:underline;cursor:pointer;padding:0 0 0 6px}' +
    '.sr-skills{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}' +
    '.sr-skills span{font-size:.72rem;background:var(--bg-soft);border:1px solid var(--line);color:var(--muted);border-radius:6px;padding:2px 7px}' +
    '.sr-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0b1f3f;color:#fff;font-size:.85rem;font-weight:600;padding:11px 18px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:9999;max-width:calc(100vw - 32px);text-align:center;opacity:0;transition:opacity .2s}' +
    '.sr-toast.on{opacity:1}' +
    '.sr-note{margin-top:10px;font-size:.76rem;color:var(--muted);line-height:1.55}' +
    '@media (max-width:640px){.sr-row{grid-template-columns:1fr}.sr-left{flex-direction:row;flex-wrap:wrap;align-items:center}.sr-name{width:100%}}';

  function el(t, a, h) { var e = document.createElement(t); if (a) for (var k in a) e.setAttribute(k, a[k]); if (h != null) e.innerHTML = h; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var toastT;
  function toast(msg) {
    var t = document.getElementById('sr-toast');
    if (!t) { t = el('div', { id: 'sr-toast', 'class': 'sr-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 3200);
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, no) {
      try { var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); ok(); } catch (e) { no(e); }
    });
  }

  function render(box) {
    var full = box.getAttribute('data-mode') === 'full';
    if (!document.getElementById('sr-css')) { var st = el('style', { id: 'sr-css' }); st.textContent = css; document.head.appendChild(st); }
    var head = el('div', { 'class': 'sr-head' });
    head.innerHTML = full ? '<span class="sr-sub" id="sr-total"></span>' :
      '<h3>🧩 전체 스킬 3부 실행</h3><span class="sr-sub" id="sr-total"></span><a href="skill-run.html">상세 · 포함 스킬 보기 →</a>';
    var list = el('div', { 'class': 'sr-list' });
    PARTS.forEach(function (p) {
      var row = el('div', { 'class': 'sr-row', id: 'sr-row-' + p.n });
      var left = el('div', { 'class': 'sr-left' });
      left.innerHTML = '<div class="sr-name">' + p.icon + ' ' + esc(p.name) + '<div class="sr-count">' + esc(p.count) + '</div></div>';
      var bReq = el('button', { type: 'button', 'class': 'sr-btn req', 'data-part': p.n }, '📨 실행 요청');
      var bCopy = el('button', { type: 'button', 'class': 'sr-btn copy', 'data-cmd': p.cmd }, '📋 문구 복사');
      left.appendChild(bReq); left.appendChild(bCopy);
      var right = el('div');
      right.innerHTML = '<p class="sr-desc">' + esc(p.desc) + '</p><div class="sr-last" id="sr-last-' + p.n + '">마지막 실행 결과 불러오는 중…</div><div class="sr-q" id="sr-q-' + p.n + '" hidden></div>' +
        (full ? '<div class="sr-skills">' + p.skills.map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>' : '');
      row.appendChild(left); row.appendChild(right); list.appendChild(row);
      bCopy.addEventListener('click', function () {
        var light = document.getElementById('sr-light');
        var cmd = p.cmd + (light && light.checked ? ' 가볍게' : '');
        copy(cmd).then(function () { toast('"' + cmd + '" 복사됨 — Claude 데스크톱 새 대화에 붙여넣으세요'); }, function () { toast('복사 실패 — 직접 입력: ' + cmd); });
      });
      bReq.addEventListener('click', function () {
        var light = document.getElementById('sr-light');
        bReq.disabled = true;
        fetch('/api/skillrun/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part: p.n, light: !!(light && light.checked) }) })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j.ok) throw new Error(j.error || '요청 실패');
            toast(j.dup ? j.message : p.n + '부 실행 요청 등록 — 텔레그램으로 알림을 보냈습니다');
            loadQueue();
          })
          .catch(function (e) { toast('요청 실패: ' + e.message); })
          .then(function () { bReq.disabled = false; });
      });
    });
    box.innerHTML = '';
    if (!full) box.className = (box.className + ' sr-wrap').trim();
    box.appendChild(head); box.appendChild(list);
    var note = el('div', { 'class': 'sr-note' });
    note.innerHTML = '권장 순서는 1부 → 2부 → 3부입니다(뒤 회차가 앞 회차의 핸드오프를 씁니다). 📨 실행 요청은 대기열에 쌓이고 @Tistock_bot으로 알림이 갑니다. 실제 실행은 Claude 데스크톱에서 <b>“스킬런 요청 처리해줘”</b>라고 말하면 시작됩니다. 📋 문구 복사는 그 회차 실행 문구를 복사합니다.';
    box.appendChild(note);
    loadStatus(); loadQueue();
  }

  function chips(o) {
    return '<span class="sr-chip sr-ok">✅ ' + (o.ok || 0) + '</span>' + (o.partial ? '<span class="sr-chip sr-pa">△ ' + o.partial + '</span>' : '') +
      (o.skip ? '<span class="sr-chip sr-sk">⏭ ' + o.skip + '</span>' : '') + '<span class="sr-chip sr-fa">❌ ' + (o.fail || 0) + '</span>';
  }
  function loadStatus() {
    fetch('/data/skillrun-status.json?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (s) {
      PARTS.forEach(function (p) {
        var d = s.parts && s.parts[p.n], box = document.getElementById('sr-last-' + p.n);
        if (!box) return;
        if (!d) { box.textContent = '아직 실행 기록이 없습니다.'; return; }
        box.innerHTML = '<b>마지막 실행 ' + esc(d.date) + '</b> ' + chips(d) + '<br>' + esc(d.headline || '');
      });
      var t = document.getElementById('sr-total');
      if (t && s.total) t.innerHTML = '최근 런 ' + esc(s.run_date) + ' · ' + chips(s.total) + (s.summary_url ? ' · <a href="' + esc(s.summary_url) + '" style="font-weight:700;color:var(--accent);text-decoration:none">종합 보고 →</a>' : '');
    }).catch(function () {
      PARTS.forEach(function (p) { var b = document.getElementById('sr-last-' + p.n); if (b) b.textContent = '실행 기록을 불러오지 못했습니다.'; });
    });
  }
  function loadQueue() {
    fetch('/api/skillrun/requests?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (j) {
      PARTS.forEach(function (p) {
        var q = document.getElementById('sr-q-' + p.n); if (!q) return;
        var it = (j.requests || []).filter(function (x) { return x.part === p.n; })[0];
        if (!it) { q.hidden = true; q.innerHTML = ''; return; }
        q.hidden = false;
        q.innerHTML = '⏳ 실행 대기 중 · ' + esc(it.requested_at) + (it.light ? ' · 가볍게' : '') + '<button type="button">요청 취소</button>';
        q.querySelector('button').onclick = function () {
          fetch('/api/skillrun/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part: p.n }) })
            .then(function () { toast(p.n + '부 요청을 취소했습니다'); loadQueue(); });
        };
      });
    }).catch(function () {});
  }

  function init() { var b = document.getElementById('skillrun-box'); if (b) render(b); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
