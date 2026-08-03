/* Trend Insight — 리포트 페이지 종목 도구 연결 위젯
   worker.js가 /posts/*.html 응답의 <head>에 자동 주입한다.
   제목에서 "종목명(6자리코드)" 또는 "[리포트 요약] 종목명" 패턴을 감지해
   웹앱 도구 바로가기 + 같은 종목 리포트 모아보기 링크를 본문 하단에 렌더링. */
(function(){
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  var h1=document.querySelector('main h1')||document.querySelector('h1');
  var title=(h1?h1.textContent:document.title)||'';
  var stocks=[],seen={},m;
  var re=/([가-힣A-Za-z0-9&·]+)\s*\((\d{6})\)/g;
  while((m=re.exec(title))){
    var n=m[1].trim();
    if(n.length>=2&&!seen[n]){seen[n]=1;stocks.push({name:n,code:m[2]});}
  }
  m=title.match(/^\[리포트 요약\]\s*([가-힣A-Za-z0-9&·]+)/);
  if(m){
    var n2=m[1].trim();
    if(n2.length>=2&&!seen[n2]){seen[n2]=1;stocks.push({name:n2,code:null});}
  }
  stocks=stocks.slice(0,2);

  var TOOLS=[
    ['적정주가','/fair-value.html'],
    ['시그널','/signal.html'],
    ['일목균형표','/ichimoku.html'],
    ['수급 콕핏','/supply.html'],
    ['고레가와','/korekawa.html'],
    ['거장 추세','/trend-masters.html']
  ];

  var css='.pt-box{margin:30px 0 0;border:1px solid #e4e9f1;border-radius:14px;background:#f5f7fb;padding:20px 22px;}'+
    '.pt-box h4{margin:0 0 4px;font-size:.95rem;color:#0b1f3f;}'+
    '.pt-box .pt-sub{font-size:.78rem;color:#9aa6b6;margin:0 0 14px;}'+
    '.pt-stock{margin-bottom:14px;}'+
    '.pt-stock:last-child{margin-bottom:0;}'+
    '.pt-name{font-weight:800;font-size:.92rem;color:#13294b;margin-bottom:8px;display:block;}'+
    '.pt-links{display:flex;flex-wrap:wrap;gap:8px;}'+
    '.pt-links a{display:inline-block;background:#fff;border:1px solid #e4e9f1;border-radius:999px;padding:7px 14px;font-size:.83rem;font-weight:700;color:#2e6ff2;text-decoration:none;}'+
    '.pt-links a:hover{border-color:#2e6ff2;}'+
    '.pt-links a.pt-arch{color:#0b1f3f;background:#eef2f9;}';
  var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

  var box=document.createElement('div');box.className='pt-box';
  var html;
  if(stocks.length){
    html='<h4>이 종목 더 보기</h4><p class="pt-sub">아래 도구에서 종목을 검색하면 최신 데이터 기준으로 다시 분석할 수 있습니다.</p>';
    stocks.forEach(function(s){
      var q=encodeURIComponent(s.name);
      html+='<div class="pt-stock"><span class="pt-name">'+esc(s.name)+(s.code?' ('+esc(s.code)+')':'')+'</span><div class="pt-links">';
      TOOLS.forEach(function(t){
        html+='<a href="'+t[1]+'?q='+q+(s.code?'&code='+esc(s.code):'')+'">'+t[0]+'</a>';
      });
      html+='<a class="pt-arch" href="/?q='+q+'#insights">📚 '+esc(s.name)+' 리포트 모아보기</a>';
      html+='</div></div>';
    });
  }else{
    html='<h4>더 찾아보기</h4><div class="pt-links">'+
      '<a class="pt-arch" href="/#insights">📚 리포트 아카이브 검색</a>'+
      '<a class="pt-arch" href="/#dashboard">📟 오늘의 계기판</a></div>';
  }
  box.innerHTML=html;
  var main=document.querySelector('main')||document.body;
  var disc=main.querySelector('.disclaimer');
  if(disc)main.insertBefore(box,disc);else main.appendChild(box);
})();
