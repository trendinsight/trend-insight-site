/* wl-signal.js — 관심종목 옆 매수/홀드/관망/매도 배지 (index.html · my-stocks.html 공용)
   판정은 서버(/api/wl-signal/{code})가 월·수·금 장 마감 후(16:00) 확정 일봉으로 내리고
   KV에 고정한다 — 주기 중간에는 장중 등락이 있어도 배지가 바뀌지 않는다.
   근거: ① 기술 점수 0~4(정배열·MACD>시그널·일목 구름 위·전환선>기준선)
         ② 종목 온도 0~100(75↑ 과열, 25↓ 침체)  ③ 논거 보드(BROKEN→매도, WEAKENED→매수를 홀드로)
   규칙: 기술≥3 & 온도<75 → 매수 | 기술≥3 & 온도≥75 → 홀드(과열) | 기술=2 → 홀드
         기술≤1 & 온도≤25 → 관망(과매도) | 기술≤1 → 매도                                          */
(function(){
  if(window.TISignal)return;
  var css='.tis{display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:22px;padding:0 7px;border-radius:6px;font-size:11.5px;font-weight:800;letter-spacing:-.2px;white-space:nowrap;flex:0 0 auto;cursor:help;border:1px solid transparent}'
    +'.tis-buy{background:#e5383b;color:#fff}'
    +'.tis-hold{background:#fff4d6;color:#9a6b00;border-color:#f0d58a}'
    +'.tis-wait{background:#eef1f5;color:#5b6778;border-color:#d8dee7}'
    +'.tis-sell{background:#2e6ff2;color:#fff}'
    +'.tis-load{background:transparent;color:#9aa6b6;border-color:#d8dee7;font-weight:600}'
    +'.tis-na{background:transparent;color:#9aa6b6;border-color:#e3e7ee;font-weight:600}'
    +'.tis-sub{font-size:10.5px;font-weight:700;opacity:.85;margin-left:3px}'
    +'@media(prefers-color-scheme:dark){.tis-hold{background:#3a2f12;color:#f3c65a;border-color:#5a4a1c}.tis-wait{background:#243041;color:#aab6c6;border-color:#34425a}}';
  var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

  /* 동시 요청 4개로 제한 (관심종목 최대 30개) */
  var q=[],active=0;
  function run(){
    while(active<4&&q.length){
      var t=q.shift();active++;
      t().then(function(){active--;run();},function(){active--;run();});
    }
  }
  function enqueue(fn){return new Promise(function(res){q.push(function(){return fn().then(res,function(){res(null);});});run();});}

  var memo={};
  function judge(code){
    if(!memo[code])memo[code]=enqueue(function(){
      return fetch('/api/wl-signal/'+code).then(function(r){return r.json();});
    }).then(function(j){return j&&j.ok?j:null;});
    return memo[code];
  }
  function md(s){s=String(s||'');if(s.length<10)return s;var w='일월화수목금토'[new Date(s+'T00:00:00Z').getUTCDay()];return (+s.slice(5,7))+'/'+(+s.slice(8,10))+'('+w+')';}

  var LABEL={buy:'매수',hold:'홀드',wait:'관망',sell:'매도'};
  function badge(el,code){
    if(!el)return;
    el.className='tis tis-load';el.textContent='…';el.title='신호 불러오는 중';
    judge(code).then(function(r){
      if(!r){el.className='tis tis-na';el.textContent='—';el.title='신호 데이터 없음(상장 초기·거래정지 등)';return;}
      el.className='tis tis-'+r.v;
      el.innerHTML=LABEL[r.v]+(r.sub?'<span class="tis-sub">'+r.sub+'</span>':'');
      el.title=LABEL[r.v]+' — '+r.why+'\n'+r.detail
        +'\n판정 '+md(r.cycle_start)+' · '+md(r.bar_date)+' 종가 기준 · 다음 판정 '+md(r.next)+(r.stale?' · 갱신 실패로 직전 판정 표시':'')
        +'\n※ 자동 산출 참고 신호이며 투자 권유가 아닙니다';
    });
  }
  window.TISignal={judge:judge,badge:badge};
})();
