/* Trend Insight — 공용 플로팅 내비게이션
   worker.js가 홈(index)을 제외한 모든 HTML 페이지 <head>에 자동 주입한다.
   우하단 ☰ 버튼 → 그룹 아코디언 패널. 각 페이지 레이아웃은 건드리지 않는다. */
(function(){
  var path=location.pathname;
  if(path==='/'||path==='/index.html')return;
  if(document.getElementById('sn-fab'))return;

  var GROUPS=[
    ['온도계',[
      ['시장 온도계','/gauge.html'],['거시 온도계','/macro-gauge.html'],
      ['군중심리 온도계','/crowd-gauge.html'],['예수금 온도계','/cash-gauge.html'],
      ['종목 온도계','/stock-gauge.html'],['코인 온도계','/crypto-gauge.html']]],
    ['스크리닝·레이더',[
      ['기간별 종목선정','/horizon-picks.html'],['거래량 레이더','/volume-radar.html'],
      ['세종기업데이터','/sejong-data.html'],['수출 펄스','/export-pulse.html'],
      ['배당성장','/dividend-growth.html'],['LTCM 수렴','/ltcm-board.html'],
      ['SA 컨빅션','/sa-conviction.html'],['스타일 로테이션','/style-rotation.html'],
      ['레버리지 스위치','/switch-gauge.html'],['하락장 레이더','/bear-gauge.html'],
      ['숏 후보 레이더','/short-radar.html']]],
    ['전략 보드',[
      ['고레가와 보드','/korekawa-board.html'],['피셔 보드','/fisher-board.html'],
      ['위대한 기업','/philip-fisher-board.html'],['추세 라이더','/trend-rider-board.html'],
      ['거장 자문단','/masters.html'],['논거 보드','/thesis-board.html'],
      ['결재 보드','/decision-board.html'],['공명 책략','/kongming-board.html'],
      ['트레이딩 데스크','/trading-desk.html']]],
    ['웹앱 도구',[
      ['적정주가','/fair-value.html'],['시그널','/signal.html'],
      ['일목균형표','/ichimoku.html'],['고레가와','/korekawa.html'],
      ['피셔','/fisher.html'],['피라미드 계산기','/pyramid-calc.html'],
      ['종목 그래프','/stock-graph.html'],['수급 콕핏','/supply.html'],
      ['업종 수급','/sector-flow.html']]],
    ['리포트',[
      ['최신 글 (검색)','/#insights'],['리포트 요약 (데일리)','/research-digest.html'],
      ['리포트 요약 요청','/report-summary.html'],['크립토 리포트','/crypto-report.html'],
      ['오늘의 격언','/proverb.html']]],
    ['소개',[
      ['회사소개','/about.html'],['문의하기','/#contact']]]
  ];

  var css=
    '#sn-fab{position:fixed;right:18px;bottom:18px;z-index:99990;width:48px;height:48px;border-radius:50%;'+
      'background:#0b1f3f;color:#fff;border:none;cursor:pointer;font-size:19px;line-height:1;'+
      'box-shadow:0 6px 20px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;}'+
    '#sn-fab:hover{background:#1a3a6b;}'+
    '#sn-ov{position:fixed;inset:0;background:rgba(8,16,32,.55);z-index:99991;display:none;}'+
    '#sn-panel{position:fixed;top:0;right:0;bottom:0;width:min(320px,88vw);background:#fff;z-index:99992;'+
      'display:none;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,.25);'+
      "font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;}"+
    '#sn-panel.on,#sn-ov.on{display:flex;}'+
    '#sn-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #e4e9f1;}'+
    '#sn-head a{font-weight:800;color:#0b1f3f;text-decoration:none;font-size:1rem;}'+
    '#sn-head a .r{color:#b22f2f;}#sn-head a .b{color:#4a7ebd;}'+
    '#sn-close{background:none;border:none;font-size:20px;cursor:pointer;color:#5b6779;padding:4px 8px;}'+
    '#sn-body{overflow-y:auto;padding:10px 12px 24px;flex:1;}'+
    '#sn-body .sn-home{display:block;padding:11px 12px;border-radius:9px;font-weight:700;color:#2e6ff2;text-decoration:none;font-size:.92rem;}'+
    '#sn-body .sn-home:hover{background:#f5f7fb;}'+
    '#sn-body details{border-bottom:1px solid #eef1f6;}'+
    '#sn-body summary{list-style:none;cursor:pointer;padding:12px;font-weight:700;color:#13294b;font-size:.92rem;'+
      'display:flex;align-items:center;justify-content:space-between;border-radius:9px;}'+
    '#sn-body summary:hover{background:#f5f7fb;}'+
    '#sn-body summary::-webkit-details-marker{display:none;}'+
    '#sn-body summary:after{content:"▾";font-size:.7rem;color:#9aa6b6;transition:transform .15s;}'+
    '#sn-body details[open] summary:after{transform:rotate(180deg);}'+
    '#sn-body .sn-links{padding:2px 0 10px 10px;}'+
    '#sn-body .sn-links a{display:block;padding:9px 12px;border-radius:8px;color:#3c4757;text-decoration:none;font-size:.88rem;font-weight:600;}'+
    '#sn-body .sn-links a:hover{background:#f5f7fb;color:#2e6ff2;}';
  var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

  function el(tag,attrs,html){
    var e=document.createElement(tag);
    for(var k in attrs)e.setAttribute(k,attrs[k]);
    if(html!=null)e.innerHTML=html;
    return e;
  }

  var fab=el('button',{id:'sn-fab',type:'button','aria-label':'전체 메뉴'},'☰');
  var ov=el('div',{id:'sn-ov'});
  var panel=el('div',{id:'sn-panel'});
  var head=el('div',{id:'sn-head'},
    '<a href="/"><span class="r">Trend</span> <span class="b">Insight</span></a>'+
    '<button id="sn-close" type="button" aria-label="닫기">✕</button>');
  var body=el('div',{id:'sn-body'});
  body.appendChild(el('a',{class:'sn-home',href:'/'},'🏠 홈 · 오늘의 계기판'));
  body.appendChild(el('a',{class:'sn-home',href:'/skill-map.html'},'🧭 스킬 맵'));
  GROUPS.forEach(function(g){
    var d=document.createElement('details');
    d.appendChild(el('summary',{},g[0]));
    var box=el('div',{class:'sn-links'});
    g[1].forEach(function(l){box.appendChild(el('a',{href:l[1]},l[0]));});
    d.appendChild(box);
    body.appendChild(d);
  });
  panel.appendChild(head);panel.appendChild(body);

  function open(){ov.classList.add('on');panel.classList.add('on');}
  function close(){ov.classList.remove('on');panel.classList.remove('on');}
  fab.addEventListener('click',open);
  ov.addEventListener('click',close);
  head.querySelector('#sn-close').addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});

  function mount(){
    document.body.appendChild(fab);
    document.body.appendChild(ov);
    document.body.appendChild(panel);
  }
  if(document.body)mount();
  else document.addEventListener('DOMContentLoaded',mount);

  /* ── 데이터 갱신일 배지 (좌하단) ─────────────────────────
     페이지별 데이터 JSON에서 최신 날짜를 뽑아 "마지막 갱신 N일 전"을 표시.
     3일 이내 파랑 · 4~7일 주황 · 8일+ 빨강. 클릭 시 닫힘. */
  var DATA_MAP={
    '/gauge.html':'market-gauge.json','/macro-gauge.html':'macro-gauge.json',
    '/crowd-gauge.html':'crowd-gauge.json','/cash-gauge.html':'cash-gauge.json',
    '/crypto-gauge.html':'crypto-gauge.json','/bear-gauge.html':'bear-gauge.json',
    '/switch-gauge.html':'switch-gauge.json','/style-rotation.html':'style-rotation.json',
    '/korekawa-board.html':'korekawa-board.json','/fisher-board.html':'fisher-board.json',
    '/philip-fisher-board.html':'philip-fisher-board.json','/trend-rider-board.html':'trend-rider-board.json',
    '/thesis-board.html':'thesis-board.json','/decision-board.html':'decision-board.json',
    '/kongming-board.html':'kongming-board.json','/horizon-picks.html':'horizon-picks.json',
    '/short-radar.html':'short-radar.json','/volume-radar.html':'volume-radar.json',
    '/sejong-data.html':'sejong-data.json','/export-pulse.html':'export-pulse.json',
    '/dividend-growth.html':'dividend-growth.json','/ltcm-board.html':'ltcm-board.json',
    '/industry-board.html':'industry-board.json','/research-digest.html':'research-digest.json',
    '/report-summary.html':'report-summaries.json','/proverb.html':'proverb-history.json',
    '/adjusted-value.html':'adjusted-value.json','/stock-graph.html':'stock-graph.json',
    '/supply.html':'supply-gauge.json','/macro-analysis.html':'macro-analysis.json',
    '/canslim.html':'canslim.json','/screener.html':'screener.json',
    '/rsi-adr.html':'rsi-adr.json','/forensic.html':'forensic.json',
    '/correlation.html':'correlation.json','/vault-audit.html':'vault-audit.json',
    '/crypto-report.html':'crypto-report.json'
  };
  var df=DATA_MAP[path.replace(/\/$/,'')]||DATA_MAP[path];
  if(df){
    fetch('/data/'+df).then(function(r){if(!r.ok)throw 0;return r.text();}).then(function(txt){
      var today=new Date();today.setHours(0,0,0,0);
      var best=null,m,re=/20\d{2}([-.\/]?)(0[1-9]|1[0-2])\1(0[1-9]|[12]\d|3[01])/g;
      while((m=re.exec(txt))){
        var iso=m[0].replace(/[.\/]/g,'-');
        if(iso.length===8)iso=iso.slice(0,4)+'-'+iso.slice(4,6)+'-'+iso.slice(6,8);
        var d=new Date(iso+'T00:00:00');
        if(isNaN(d)||d>today||d.getFullYear()<2020)continue;
        if(!best||d>best)best=d;
      }
      if(!best)return;
      var days=Math.round((today-best)/864e5);
      var col=days<=3?'#2e6ff2':days<=7?'#e8830c':'#e5484d';
      var label='\uB9C8\uC9C0\uB9C9 \uAC31\uC2E0 '+(best.getMonth()+1)+'.'+best.getDate()+' \u00B7 '+(days===0?'\uC624\uB298':days+'\uC77C \uC804');
      var b=document.createElement('div');
      b.id='sn-fresh';
      b.style.cssText='position:fixed;left:14px;bottom:14px;z-index:99989;background:rgba(255,255,255,.96);border:1.5px solid '+col+';color:'+col+';font-weight:700;font-size:12px;padding:6px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer;font-family:Pretendard,-apple-system,BlinkMacSystemFont,sans-serif;';
      b.textContent='\uD83D\uDCC5 '+label;
      b.title='\uD074\uB9AD\uD558\uBA74 \uB2EB\uD799\uB2C8\uB2E4';
      b.addEventListener('click',function(){b.remove();});
      if(document.body)document.body.appendChild(b);
      else document.addEventListener('DOMContentLoaded',function(){document.body.appendChild(b);});
    }).catch(function(){});
  }
})();
