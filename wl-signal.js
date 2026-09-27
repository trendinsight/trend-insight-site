/* wl-signal.js — 관심종목 옆 매수/홀드/관망/매도 배지 (index.html · my-stocks.html 공용)
   판정 근거 (모두 실시간, 엣지 캐시 3분):
   ① 기술 점수 0~4  /api/cockpit/analyze  — 정배열·MACD>시그널·일목 구름 위·전환선>기준선
   ② 종목 온도 0~100 /api/cockpit/thermo   — MACD 백분위·RSI·스토캐스틱·투자심리도 (75↑ 과열, 25↓ 침체)
   ③ 논거 보드 상태  data/thesis-board.json — BROKEN이면 매도, WEAKENED면 매수→홀드로 한 단계 낮춤
   규칙: 기술≥3 & 온도<75 → 매수 | 기술≥3 & 온도≥75 → 홀드(과열) | 기술=2 → 홀드
         기술≤1 & 온도≤25 → 관망(과매도, 반등 확인 전 대기) | 기술≤1 → 매도                       */
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

  var thesisP=null;
  function thesis(){
    if(!thesisP)thesisP=fetch('/data/thesis-board.json',{cache:'no-store'}).then(function(r){return r.json();})
      .then(function(j){var m={};(j.stocks||[]).forEach(function(s){m[s.code]=s.status;});return m;})
      .catch(function(){return {};});
    return thesisP;
  }
  function getJ(u){return fetch(u).then(function(r){return r.json();}).catch(function(){return null;});}

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
    if(!memo[code])memo[code]=judgeRaw(code);
    return memo[code];
  }
  function judgeRaw(code){
    return enqueue(function(){
      return Promise.all([getJ('/api/cockpit/analyze/'+code),getJ('/api/cockpit/thermo/'+code),thesis()]);
    }).then(function(r){
      if(!r)return null;
      var a=r[0],t=r[1],th=r[2]||{};
      var s=a&&a.ok&&a.data&&a.data.signals;
      if(!s||s.score==null)return null;
      var tech=s.score;
      var g=t&&t.ok&&t.data&&t.data.gauge;
      var temp=g&&g.score!=null?Math.round(g.score):null;
      var ts=th[code]||null;
      var v,sub='',why;
      if(tech>=3){
        if(temp!=null&&temp>=75){v='hold';sub='과열';why='추세는 강세지만 온도 과열 — 신규 추격 자제, 보유분 유지';}
        else{v='buy';why='추세 강세 + 과열 아님 — 매수 우위';}
      }else if(tech===2){v='hold';why='추세 신호 엇갈림(중립) — 보유 유지, 신규 진입 보류';}
      else{
        if(temp!=null&&temp<=25){v='wait';sub='과매도';why='추세 약세지만 과매도 — 투매 매도보다 반등 확인 대기';}
        else{v='sell';why='추세 약세 — 비중 축소·손절선 점검';}
      }
      if(ts==='BROKEN'){v='sell';sub='논거';why='논거 보드 BROKEN(논거 훼손) — 매도 원칙';}
      else if(ts==='WEAKENED'&&v==='buy'){v='hold';sub='논거↓';why='기술적으로는 매수 신호지만 논거 약화(WEAKENED) — 추가 매수 보류';}
      var bits=['기술 '+tech+'/4('+(s.verdict||'')+')'];
      if(temp!=null)bits.push('온도 '+temp+'°'+(g.zone?' '+g.zone:''));
      if(s.jby_steps)bits.push('정배열 '+s.jby_steps);
      if(s.macd)bits.push('MACD '+(s.macd.above_signal?'시그널 위':'시그널 아래'));
      if(s.ichimoku)bits.push(s.ichimoku.above_cloud?'구름 위':'구름 아래');
      if(ts)bits.push('논거 '+ts);
      return {v:v,sub:sub,why:why,detail:bits.join(' · ')};
    });
  }

  var LABEL={buy:'매수',hold:'홀드',wait:'관망',sell:'매도'};
  function badge(el,code){
    if(!el)return;
    el.className='tis tis-load';el.textContent='…';el.title='신호 계산 중';
    judge(code).then(function(r){
      if(!r){el.className='tis tis-na';el.textContent='—';el.title='신호 데이터 없음(상장 초기·거래정지 등)';return;}
      el.className='tis tis-'+r.v;
      el.innerHTML=LABEL[r.v]+(r.sub?'<span class="tis-sub">'+r.sub+'</span>':'');
      el.title=LABEL[r.v]+' — '+r.why+'\n'+r.detail+'\n※ 자동 산출 참고 신호이며 투자 권유가 아닙니다';
    });
  }
  window.TISignal={judge:judge,badge:badge};
})();
