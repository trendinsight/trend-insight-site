/* Trend Insight — 페이지 내장 PDF 뷰어 (PDF.js)
   worker.js가 /posts/*.html 및 PDF 래퍼 페이지에 자동 주입한다.

   왜 필요한가: iOS Safari는 <iframe src="*.pdf">를 첫 장만 보여주고, 탭하면
   최상위 창을 PDF 파일 주소로 이동시켜 버린다. 그 순간 우리 HTML(=뒤로/홈 버튼)이 사라진다.
   그래서 PDF를 캔버스로 직접 렌더링해 "페이지를 떠나지 않게" 만든다.

   대상: iframe.viewer (게시글 PDF 뷰어 래퍼) — 실패하면 원래 iframe을 그대로 되돌린다. */
(function () {
  var PDFJS_VER = '3.11.174';
  var LIB = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VER + '/build/pdf.min.js';
  var WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VER + '/build/pdf.worker.min.js';
  var MAX_W = 1000;

  var iframe = document.querySelector('iframe.viewer');
  if (!iframe || !iframe.getAttribute('src')) return;
  var src = iframe.getAttribute('src');
  if (!/\.pdf(\?|$)/i.test(src)) return;

  // 원본 PDF를 그대로 받도록 raw 플래그를 붙인다 (서버가 래퍼 HTML로 감싸지 않게)
  var rawSrc = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'raw=1';

  var css =
    '.pv-doc{width:100%;background:#eceff5;border:1px solid #e4e9f1;border-radius:12px;padding:10px;box-sizing:border-box;}' +
    '.pv-page{position:relative;margin:0 auto 12px;background:#fff;box-shadow:0 1px 6px rgba(11,31,63,.14);' +
      'border-radius:4px;overflow:hidden;max-width:100%;}' +
    '.pv-page:last-child{margin-bottom:0;}' +
    '.pv-page canvas{display:block;width:100%;height:auto;}' +
    '.pv-num{position:absolute;right:8px;bottom:8px;background:rgba(11,31,63,.72);color:#fff;' +
      'font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;pointer-events:none;}' +
    '.pv-msg{padding:26px 18px;text-align:center;color:#5b6779;font-size:.9rem;}' +
    '.pv-msg a{color:#2e6ff2;font-weight:700;}' +
    '@media print{.pv-doc{border:none;background:none;padding:0;}}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var box = document.createElement('div');
  box.className = 'pv-doc';
  box.innerHTML = '<div class="pv-msg">PDF를 불러오는 중…</div>';
  iframe.parentNode.insertBefore(box, iframe);
  iframe.style.display = 'none';

  function fail(msg) {
    // PDF.js를 못 쓰면 원래 내장 뷰어로 되돌린다
    box.parentNode.removeChild(box);
    iframe.style.display = '';
    if (msg && window.console) console.warn('[pdf-viewer]', msg);
  }

  function loadScript(url, cb, onerr) {
    var s = document.createElement('script');
    s.src = url;
    s.onload = cb;
    s.onerror = onerr;
    document.head.appendChild(s);
  }

  loadScript(LIB, start, function () { fail('pdf.js 로드 실패'); });

  function start() {
    var pdfjsLib = window.pdfjsLib || (window.pdfjsDistBuildPdf || {});
    if (!pdfjsLib || !pdfjsLib.getDocument) return fail('pdfjsLib 없음');
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;

    pdfjsLib.getDocument({ url: rawSrc, withCredentials: true }).promise.then(function (pdf) {
      box.innerHTML = '';
      var fb = document.querySelector('.fallback');
      if (fb) fb.textContent = '이 페이지 안에서 PDF 전체를 볼 수 있습니다. 원본 파일이 필요하면 위의 \'PDF 다운로드\' 버튼을 누르세요.';

      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var cssW = Math.min(box.clientWidth - 20, MAX_W);
      var slots = [];

      for (var i = 1; i <= pdf.numPages; i++) {
        var d = document.createElement('div');
        d.className = 'pv-page';
        d.style.width = cssW + 'px';
        d.innerHTML = '<span class="pv-num">' + i + ' / ' + pdf.numPages + '</span>';
        box.appendChild(d);
        slots.push({ el: d, num: i, done: false });
      }

      function render(slot) {
        if (slot.done) return;
        slot.done = true;
        pdf.getPage(slot.num).then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var scale = cssW / base.width;
          var vp = page.getViewport({ scale: scale });
          var canvas = document.createElement('canvas');
          canvas.width = Math.floor(vp.width * dpr);
          canvas.height = Math.floor(vp.height * dpr);
          canvas.style.width = '100%';
          slot.el.insertBefore(canvas, slot.el.firstChild);
          slot.el.style.height = '';
          page.render({
            canvasContext: canvas.getContext('2d'),
            viewport: page.getViewport({ scale: scale * dpr })
          });
        }).catch(function (e) { if (window.console) console.warn('[pdf-viewer] page', slot.num, e); });
      }

      // 화면 근처 페이지만 렌더링 (모바일 메모리 절약)
      if ('IntersectionObserver' in window) {
        // 높이를 모르면 관찰이 한 번에 다 걸리므로 A4 비율로 임시 높이 부여
        slots.forEach(function (s) { s.el.style.height = Math.round(cssW * 1.414) + 'px'; });
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (!en.isIntersecting) return;
            var s = slots[Number(en.target.dataset.i)];
            io.unobserve(en.target);
            render(s);
          });
        }, { rootMargin: '800px 0px' });
        slots.forEach(function (s, i) { s.el.dataset.i = i; io.observe(s.el); });
      } else {
        slots.forEach(render);
      }
    }).catch(function (e) { fail(e && e.message); });
  }
})();
