/* Trend Insight — 리포트 페이지 뒤로/홈 내비게이션
   worker.js가 /posts/*.html 및 PDF 뷰어 페이지(<head>)에 자동 주입한다.
   ① 상단 header를 스크롤해도 붙어있게(sticky) 고정하고 [← 뒤로] [홈] 버튼을 넣는다.
   ② 우하단에 항상 떠 있는 원형 뒤로·홈 버튼을 site-nav.js의 ☰ FAB 위로 쌓는다.
   기존 페이지 레이아웃/마크업은 건드리지 않는다. */
(function () {
  if (document.getElementById('pn-fab-home')) return;

  var HOME = '/';

  function goBack() {
    // 이 사이트 안에서 넘어온 경우에만 뒤로가기, 그 외(외부 유입·첫 진입)는 홈으로
    var sameSite = document.referrer && document.referrer.indexOf(location.origin) === 0;
    if (window.history.length > 1 && sameSite) window.history.back();
    else location.href = HOME;
  }

  var css =
    /* ── 상단 고정 바 ── */
    'header.pn-sticky{position:sticky;top:0;z-index:99988;display:flex;align-items:center;gap:10px;' +
      '-webkit-backdrop-filter:saturate(180%) blur(6px);backdrop-filter:saturate(180%) blur(6px);}' +
    'header.pn-sticky .pn-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.pn-btn{flex:none;display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.14);' +
      'color:#fff;border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:6px 13px;' +
      'font-size:.82rem;font-weight:700;line-height:1.2;text-decoration:none;cursor:pointer;' +
      "font-family:inherit;-webkit-appearance:none;appearance:none;}" +
    '.pn-btn:hover,.pn-btn:active{background:rgba(255,255,255,.26);}' +
    /* ── 우하단 플로팅 버튼 (site-nav.js ☰ FAB 위로 쌓기) ── */
    '.pn-fab{position:fixed;right:18px;z-index:99990;width:48px;height:48px;border-radius:50%;' +
      'background:#fff;color:#0b1f3f;border:1.5px solid #d5dceb;cursor:pointer;' +
      'font-size:12.5px;font-weight:800;line-height:1.15;text-align:center;text-decoration:none;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;' +
      "font-family:Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;}" +
    '.pn-fab:hover{background:#eef2f9;border-color:#2e6ff2;color:#2e6ff2;}' +
    '#pn-fab-home{bottom:calc(74px + env(safe-area-inset-bottom,0px));}' +
    '#pn-fab-back{bottom:calc(130px + env(safe-area-inset-bottom,0px));}' +
    '@media print{.pn-fab,.pn-btn{display:none!important;}}';

  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function build() {
    /* ① 상단 header 고정 + 버튼 삽입 (서버가 이미 버튼을 넣은 페이지면 건너뜀) */
    var hd = document.querySelector('body > header') || document.querySelector('header');
    if (hd && !hd.querySelector('.pn-btn')) {
      hd.classList.add('pn-sticky');
      var link = hd.querySelector('a');
      if (link) {
        link.classList.add('pn-title');
        // "← Trend Insight" 의 화살표는 옆에 생기는 [← 뒤로]와 겹치므로 제거
        link.textContent = link.textContent.replace(/^\s*←\s*/, '').trim() || 'Trend Insight';
      }
      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'pn-btn';
      back.textContent = '← 뒤로';
      back.setAttribute('aria-label', '이전 화면으로');
      back.addEventListener('click', goBack);

      var home = document.createElement('a');
      home.className = 'pn-btn';
      home.href = HOME;
      home.textContent = '홈';
      home.setAttribute('aria-label', '홈으로');

      hd.insertBefore(back, hd.firstChild);
      hd.appendChild(home);
    }

    /* ② 'PDF 다운로드' 버튼을 [크게 보기 | 다운로드] 둘로 분리
          - 크게 보기: PDF 주소로 이동 → 서버가 뒤로/홈 바 달린 뷰어 페이지로 감싸준다
          - 다운로드: ?dl=1 → 첨부파일로 저장 (화면 전환 없음)
          래퍼 페이지(주소가 .pdf) 위에서는 '크게 보기'가 무의미하므로 다운로드만 정리 */
    var onWrapper = /\.pdf$/i.test(location.pathname);
    Array.prototype.forEach.call(document.querySelectorAll('a[href$=".pdf"]'), function (a) {
      var href = a.getAttribute('href');
      a.setAttribute('href', href + '?dl=1');
      a.removeAttribute('download'); // Content-Disposition 이 처리한다
      if (a.classList.contains('dl')) {
        a.textContent = '⬇ 다운로드';
        if (!onWrapper) {
          var view = document.createElement('a');
          view.className = 'dl';
          view.href = href; // 원 주소 그대로 → 서버 래퍼(내장 뷰어 + 뒤로/홈)
          view.textContent = '📄 크게 보기';
          view.style.marginRight = '8px';
          a.parentNode.insertBefore(view, a);
          a.style.background = '#5b6779';
        }
      }
    });

    /* ③ 우하단 플로팅 버튼 */
    var fb = document.createElement('button');
    fb.type = 'button';
    fb.id = 'pn-fab-back';
    fb.className = 'pn-fab';
    fb.textContent = '뒤로';
    fb.title = '이전 화면으로';
    fb.setAttribute('aria-label', '이전 화면으로');
    fb.addEventListener('click', goBack);

    var fh = document.createElement('a');
    fh.id = 'pn-fab-home';
    fh.className = 'pn-fab';
    fh.href = HOME;
    fh.textContent = '홈';
    fh.title = '홈으로';
    fh.setAttribute('aria-label', '홈으로');

    document.body.appendChild(fb);
    document.body.appendChild(fh);
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
