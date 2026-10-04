/* Trend Insight — 뒤로 ← / 앞으로 → 화살표 내비게이션
   worker.js가 홈을 포함한 모든 HTML 페이지 <head>에 자동 주입한다.
   브라우저의 뒤로/앞으로와 같은 동작을 화면 좌하단 화살표로 제공한다.
   - 뒤로 가기를 거듭한 뒤에는 → 버튼으로 다시 앞쪽(방금 보던 페이지)으로 이동
   - 새 페이지로 이동하면 앞쪽 기록은 브라우저와 똑같이 사라진다
   - 이 탭의 이동 기록을 sessionStorage에 따로 들고 있어
     브라우저가 '앞으로 갈 곳이 있는지' 알려주지 않는 Safari·Firefox에서도 버튼 활성/비활성이 맞다 */
(function () {
  if (window.__tiHistNav) return;
  window.__tiHistNav = true;

  var KEY = 'ti-hist-v1';
  var isHome = location.pathname === '/' || location.pathname === '/index.html';

  /* ── 기록 저장소 ── */
  function load() {
    try { var s = JSON.parse(sessionStorage.getItem(KEY)); if (s && s.list) return s; } catch (e) {}
    return { list: [], pos: -1, seq: 0 };
  }
  function save(s) { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  var S = load();

  /* 페이지 스크립트가 history.replaceState(null, …)로 상태를 지워도 표식(tiH)은 유지 */
  function keep(fn) {
    return function (state, title, url) {
      var cur = history.state && history.state.tiH;
      if (cur != null && (state == null || typeof state === 'object') && !(state && state.tiH != null)) {
        state = Object.assign({}, state || {}, { tiH: cur });
      }
      return fn.call(history, state, title, url);
    };
  }
  try {
    history.replaceState = keep(history.replaceState);
    var _push = history.pushState;
    history.pushState = function (state, title, url) {
      // pushState는 새 항목이므로 표식을 새로 매긴다
      var id = ++S.seq;
      S.list = S.list.slice(0, S.pos + 1);
      S.list.push({ id: id, t: document.title, u: String(url || location.href) });
      S.pos = S.list.length - 1; save(S);
      var st = Object.assign({}, (state && typeof state === 'object') ? state : {}, { tiH: id });
      var r = _push.call(history, st, title, url);
      render();
      return r;
    };
  } catch (e) {}

  function idxOf(id) {
    for (var i = 0; i < S.list.length; i++) if (S.list[i].id === id) return i;
    return -1;
  }

  /* 현재 항목 등록/위치 동기화 */
  function sync() {
    S = load();
    var id = history.state && history.state.tiH;
    var i = id != null ? idxOf(id) : -1;
    if (i >= 0) {
      S.pos = i;                                   // 뒤로/앞으로·새로고침으로 돌아온 항목
      S.list[i].t = document.title || S.list[i].t;
    } else {
      // 새 탭(브라우저 기록 1개)인데 저장소가 복사돼 온 경우 → 이 탭 기준으로 새로 시작
      if (history.length === 1) { S.list = []; S.pos = -1; }
      // 처음 보는 항목 = 새 이동 → 앞쪽 기록을 잘라내고 끝에 추가
      id = ++S.seq;
      S.list = S.list.slice(0, S.pos + 1);
      S.list.push({ id: id, t: document.title, u: location.href });
      if (S.list.length > 200) S.list = S.list.slice(-200);
      S.pos = S.list.length - 1;
      try {
        var st = (history.state && typeof history.state === 'object') ? history.state : {};
        history.replaceState(Object.assign({}, st, { tiH: id }), '', location.href);
      } catch (e) {}
    }
    save(S);
  }
  sync();

  /* ── UI ── */
  var css =
    '#hn-bar{position:fixed;left:14px;bottom:' + (isHome ? '18px' : '58px') + ';z-index:99989;display:flex;gap:6px;' +
      'padding:5px;border-radius:999px;background:rgba(255,255,255,.96);border:1px solid #d5dceb;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.2);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
      'margin-bottom:env(safe-area-inset-bottom,0px);}' +
    '#hn-bar button{width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;background:#0b1f3f;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s,opacity .15s;}' +
    '#hn-bar button svg{width:20px;height:20px;}' +
    '#hn-bar button:hover:not(:disabled){background:#2e6ff2;}' +
    '#hn-bar button:disabled{background:#e4e9f1;color:#9aa6b6;cursor:default;}' +
    '#hn-bar .hn-n{position:absolute;top:-6px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;' +
      'background:#e8621b;color:#fff;font:700 10px/17px Pretendard,-apple-system,sans-serif;text-align:center;pointer-events:none;}' +
    '#hn-bar .hn-wrap{position:relative;}' +
    '#hn-bar .hn-wrap.b .hn-n{left:-4px;}#hn-bar .hn-wrap.f .hn-n{right:-4px;}' +
    '@media print{#hn-bar{display:none!important;}}';

  var ICON_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  var ICON_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

  var bar, bBack, bFwd, nBack, nFwd;

  function short(t) { t = (t || '').replace(/\s*[|·—-]\s*Trend Insight.*$/i, '').trim(); return t.length > 28 ? t.slice(0, 27) + '…' : (t || '페이지'); }

  function render() {
    if (!bar) return;
    S = load();
    var back = S.pos, fwd = S.list.length - 1 - S.pos;
    // 기록이 없어도 홈이 아닌 페이지(외부 유입·첫 진입)에서는 ← 로 홈에 갈 수 있게 한다
    var homeFallback = back <= 0 && !isHome;
    bBack.disabled = back <= 0 && !homeFallback;
    bFwd.disabled = fwd <= 0;
    bBack.title = back > 0 ? '뒤로: ' + short(S.list[S.pos - 1].t) : (homeFallback ? '홈으로' : '이전 화면 없음');
    bFwd.title = fwd > 0 ? '앞으로: ' + short(S.list[S.pos + 1].t) : '앞 화면 없음';
    nBack.textContent = back; nBack.style.display = back > 1 ? '' : 'none';
    nFwd.textContent = fwd; nFwd.style.display = fwd > 1 ? '' : 'none';
  }

  function goBack() {
    S = load();
    if (S.pos > 0) history.back();
    else if (!isHome) location.href = '/';
  }
  function goFwd() {
    S = load();
    if (S.pos < S.list.length - 1) history.forward();
  }

  function mount() {
    if (document.getElementById('hn-bar')) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    bar = document.createElement('div'); bar.id = 'hn-bar'; bar.setAttribute('role', 'navigation'); bar.setAttribute('aria-label', '뒤로/앞으로');
    var wb = document.createElement('span'); wb.className = 'hn-wrap b';
    var wf = document.createElement('span'); wf.className = 'hn-wrap f';
    bBack = document.createElement('button'); bBack.type = 'button'; bBack.innerHTML = ICON_L; bBack.setAttribute('aria-label', '뒤로');
    bFwd = document.createElement('button'); bFwd.type = 'button'; bFwd.innerHTML = ICON_R; bFwd.setAttribute('aria-label', '앞으로');
    nBack = document.createElement('span'); nBack.className = 'hn-n';
    nFwd = document.createElement('span'); nFwd.className = 'hn-n';
    wb.appendChild(bBack); wb.appendChild(nBack);
    wf.appendChild(bFwd); wf.appendChild(nFwd);
    bar.appendChild(wb); bar.appendChild(wf);
    bBack.addEventListener('click', goBack);
    bFwd.addEventListener('click', goFwd);
    document.body.appendChild(bar);
    render();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  /* 같은 문서 안 이동(#해시)·bfcache 복귀 때 위치 재동기화 */
  window.addEventListener('popstate', function () { sync(); render(); });
  window.addEventListener('hashchange', function () { sync(); render(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) { sync(); render(); } });

  /* Alt+← / Alt+→ 는 브라우저 기본 동작 그대로 둔다 */
})();
