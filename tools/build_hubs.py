# -*- coding: utf-8 -*-
"""Trend Insight 합본(허브) 페이지 생성기 — 2026-11-26 스킬 정리

겹치는 페이지들을 하나의 메뉴 항목으로 묶는다. 원본 페이지는 그대로 두고
(각 스킬이 계속 원본 파일·data JSON 에 게시) 허브가 탭으로 원본을 품는다.

  python tools/build_hubs.py      → 저장소 루트에 *-hub.html 생성

허브 구성을 바꾸려면 HUBS 만 고치고 다시 실행한다.
탭 주소: /timing-hub.html#trend  (해시 = 탭 키, 하위 탭은 #masters-kor.board 처럼 점으로)
쿼리 전달: /flow-hub.html?code=005930 → 각 탭 원본에 ?code=005930 그대로 전달
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# key, 탭 이름, 원본 주소 또는 하위 탭 목록, 설명
HUBS = {
    "flow-hub.html": {
        "title": "종목 수급", "skill": "supply-demand-analyzer · stock-flow",
        "desc": "종목 하나의 투자자별 수급 — 매집·분산 판정과 일별 추이를 한 곳에서",
        "tabs": [
            ["cockpit", "수급 콕핏", "/supply.html", "매집·분산 판정 (supply-demand-analyzer)"],
            ["trend", "투자자별 추이", "/stock-flow.html", "일별 투자자 매수 추이·엑셀 (stock-flow)"],
        ],
    },
    "sector-hub.html": {
        "title": "업종 수급", "skill": "kospi-sector-rotation · sector-flow",
        "desc": "업종×투자자 수급 — 코스피/코스닥 로테이션 국면과 일별 업종 수급",
        "tabs": [
            ["kospi", "코스피 로테이션", "/sector-rotation.html", "코스피 23업종 로테이션 국면·주도주"],
            ["kosdaq", "코스닥 로테이션", "/kosdaq-sector-rotation.html", "코스닥 21업종 로테이션 국면·주도주"],
            ["daily", "일별 업종 수급", "/sector-flow.html", "업종 일별 투자자 수급 차트 (sector-flow)"],
        ],
    },
    "timing-hub.html": {
        "title": "타이밍 렌즈", "skill": "horizon-timing",
        "desc": "한 종목을 장기·중기·단기 세 층으로 — 추세 라이더·종목 온도·종목 볼린저를 층으로 흡수",
        "tabs": [
            ["lens", "타이밍 렌즈 (3층)", "/timing-lens.html", "장기 허가 · 중기 선택 · 단기 시점 종합"],
            ["trend", "중기층 · 추세 라이더", "/trend-rider-board.html", "와인스타인 단계·추세 강도·RS·트레일링 출구"],
            ["temp", "단기층 · 종목 온도", "/stock-gauge.html", "종목 과열/과매도 온도"],
            ["bb", "단기층 · 종목 볼린저", "/bb-stock.html", "%B 구간 추가매수·홀딩·추가매도 판정"],
        ],
    },
    "value-hub.html": {
        "title": "적정주가", "skill": "fair-value-band",
        "desc": "적정가치 밴드 + 보정 옵션(adjusted-fair-value)",
        "tabs": [
            ["band", "적정주가 밴드", "/fair-value.html", "fair-value-band 기본 산출"],
            ["adjusted", "보정 옵션", "/adjusted-value.html", "보정 적정가 (adjusted-fair-value)"],
        ],
    },
    "masters-hub.html": {
        "title": "거장 자문단", "skill": "masters-council",
        "desc": "거장 13인 종합 채점이 본체 — 고레가와·켄 피셔·필립 피셔는 상세 탭",
        "tabs": [
            ["council", "거장 자문단 13인", "/masters.html", "13인 거장 종합 채점 (masters-council)"],
            ["korekawa", "고레가와", [["app", "검색", "/korekawa.html"], ["board", "누적 기록", "/korekawa-board.html"]], "소외 저PBR 매집 (korekawa-method)"],
            ["kfisher", "켄 피셔", [["app", "검색", "/fisher.html"], ["board", "누적 기록", "/fisher-board.html"]], "PSR·글리치 (fisher-method)"],
            ["pfisher", "필립 피셔", [["app", "15포인트 채점", "/philip-fisher.html"], ["board", "위대한 기업 기록", "/philip-fisher-board.html"]], "15포인트 위대한 기업 (philip-fisher-method)"],
        ],
    },
    "sotp-hub.html": {
        "title": "SOTP", "skill": "sotp-valuation",
        "desc": "부분합산가치 — 검색·계산과 누적 기록",
        "tabs": [
            ["app", "검색·계산", "/sotp.html", "종목 SOTP 즉석 계산"],
            ["board", "누적 기록", "/sotp-board.html", "SOTP 보드 (날짜별 누적)"],
        ],
    },
    "vp-hub.html": {
        "title": "매물대", "skill": "volume-profile",
        "desc": "가격대별 거래량 — 검색·계산과 누적 기록",
        "tabs": [
            ["app", "검색·계산", "/volume-profile.html", "종목 매물대 즉석 계산"],
            ["board", "누적 기록", "/volume-profile-board.html", "매물대 보드 (날짜별 누적)"],
        ],
    },
    "picks-hub.html": {
        "title": "종목선정", "skill": "horizon-stock-picker · weekly-top-picks",
        "desc": "기간별 15종목(단기·중기·장기) + 매주 토요일 주간 Top5와 성과 추적",
        "tabs": [
            ["horizon", "기간별 15종목", "/horizon-picks.html", "단기·중기·장기 각 5종목 (horizon-stock-picker)"],
            ["weekly", "주간 Top5", "/weekly-top-picks.html", "다음 주 Top5 + 주간 성과 누적 (weekly-top-picks)"],
        ],
    },
}

TEMPLATE = r"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>__TITLE__ — Trend Insight</title>
<meta name="description" content="__DESC__">
<link rel="icon" href="/icon-192.png">
<!-- 이 파일은 tools/build_hubs.py 가 생성한다. 직접 고치지 말고 생성기를 고칠 것. -->
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#f4f6fa;font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;color:#13294b}
#hub-top{background:#0b1f3f;color:#fff;padding:10px 16px 0;position:sticky;top:0;z-index:50;box-shadow:0 2px 10px rgba(0,0,0,.18)}
.hb-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.hb-logo{font-weight:800;text-decoration:none;font-size:.95rem;white-space:nowrap}
.hb-logo .r{color:#ff6b6b}.hb-logo .b{color:#7aa7ff}
.hb-title{font-size:1.05rem;font-weight:800}
.hb-skill{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.72rem;color:#8fa4c4}
.hb-desc{font-size:.78rem;color:#c9d6ea;margin-left:auto}
@media(max-width:760px){.hb-desc{display:none}}
.hb-tabs{display:flex;gap:4px;margin-top:9px;overflow-x:auto;scrollbar-width:none}
.hb-tabs::-webkit-scrollbar{display:none}
.hb-tab{flex:0 0 auto;border:none;background:transparent;color:#c9d6ea;font:inherit;font-size:.88rem;font-weight:700;padding:9px 14px;border-radius:9px 9px 0 0;cursor:pointer;white-space:nowrap}
.hb-tab:hover{color:#fff;background:rgba(255,255,255,.06)}
.hb-tab.on{background:#f4f6fa;color:#0b1f3f}
#hub-sub{display:none;align-items:center;gap:6px;padding:8px 16px;background:#fff;border-bottom:1px solid #e1e6ef;flex-wrap:wrap}
#hub-sub.on{display:flex}
.hb-sub{border:1px solid #d5dce8;background:#fff;color:#3c4757;font:inherit;font-size:.82rem;font-weight:700;padding:6px 13px;border-radius:999px;cursor:pointer}
.hb-sub.on{background:#2e6ff2;border-color:#2e6ff2;color:#fff}
.hb-note{font-size:.76rem;color:#6b778a;margin-left:6px}
.hb-open{margin-left:auto;font-size:.78rem;color:#2e6ff2;text-decoration:none;font-weight:700}
#hub-frames{position:relative}
#hub-frames iframe{display:none;width:100%;border:0;background:#fff}
#hub-frames iframe.on{display:block}
#hub-load{position:absolute;left:0;right:0;top:40px;text-align:center;color:#8a96a8;font-size:.9rem;pointer-events:none}
</style>
</head>
<body>
<div id="hub-top">
  <div class="hb-row">
    <a class="hb-logo" href="/"><span class="r">Trend</span> <span class="b">Insight</span></a>
    <span class="hb-title">__TITLE__</span>
    <span class="hb-skill">(__SKILL__)</span>
    <span class="hb-desc">__DESC__</span>
  </div>
  <div class="hb-tabs" id="hub-tabs" role="tablist"></div>
</div>
<div id="hub-sub"></div>
<div id="hub-frames"><div id="hub-load">불러오는 중…</div></div>
<script>
(function(){
  var TABS=__TABS__;
  var KEY='ti-hub:'+location.pathname;
  var tabsEl=document.getElementById('hub-tabs'),subEl=document.getElementById('hub-sub'),
      framesEl=document.getElementById('hub-frames'),loadEl=document.getElementById('hub-load');
  var frames={},cur=null;
  function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){return null;}}
  function srcOf(u){return u+(location.search||'');}
  function fit(){
    var h=window.innerHeight-document.getElementById('hub-top').offsetHeight-(subEl.classList.contains('on')?subEl.offsetHeight:0);
    for(var k in frames)frames[k].style.height=Math.max(h,320)+'px';
  }
  function find(key){
    var p=String(key||'').split('.'),t=null,s=null;
    for(var i=0;i<TABS.length;i++)if(TABS[i][0]===p[0])t=TABS[i];
    if(!t)t=TABS[0];
    if(Array.isArray(t[2])){
      for(var j=0;j<t[2].length;j++)if(t[2][j][0]===p[1])s=t[2][j];
      if(!s)s=t[2][0];
    }
    return {t:t,s:s};
  }
  function show(key,push){
    var f=find(key),t=f.t,s=f.s,url=s?s[2]:t[2],id=t[0]+(s?'.'+s[0]:'');
    [].forEach.call(tabsEl.children,function(b){b.classList.toggle('on',b.dataset.k===t[0]);b.setAttribute('aria-selected',b.dataset.k===t[0]);});
    subEl.innerHTML='';
    if(s){
      t[2].forEach(function(x){var b=document.createElement('button');b.className='hb-sub'+(x[0]===s[0]?' on':'');b.textContent=x[1];b.onclick=function(){show(t[0]+'.'+x[0],true);};subEl.appendChild(b);});
    }
    var note=document.createElement('span');note.className='hb-note';note.textContent=t[3]||'';subEl.appendChild(note);
    var a=document.createElement('a');a.className='hb-open';a.href=srcOf(url);a.target='_blank';a.rel='noopener';a.textContent='새 창으로 열기 ↗';subEl.appendChild(a);
    subEl.classList.add('on');
    if(!frames[id]){
      var fr=document.createElement('iframe');fr.src=srcOf(url);fr.title=(s?t[1]+' · '+s[1]:t[1]);
      fr.addEventListener('load',function(){loadEl.style.display='none';
        try{var d=fr.contentDocument;if(d&&d.title)document.title=document.title;}catch(e){}});
      framesEl.appendChild(fr);frames[id]=fr;loadEl.style.display='block';
    }
    for(var k in frames)frames[k].classList.toggle('on',k===id);
    cur=id;store(KEY,id);
    if(push&&location.hash!=='#'+id)history.replaceState(null,'','#'+id);
    fit();
  }
  TABS.forEach(function(t){
    var b=document.createElement('button');b.type='button';b.className='hb-tab';b.dataset.k=t[0];b.setAttribute('role','tab');b.textContent=t[1];b.title=t[3]||'';
    b.onclick=function(){show(t[0],true);};tabsEl.appendChild(b);
  });
  window.addEventListener('resize',fit);
  window.addEventListener('hashchange',function(){var h=location.hash.slice(1);if(h&&h!==cur)show(h,false);});
  show(location.hash.slice(1)||store(KEY)||TABS[0][0],false);
})();
</script>
</body>
</html>
"""


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def build():
    for fn, h in HUBS.items():
        html = (TEMPLATE.replace("__TITLE__", esc(h["title"]))
                .replace("__DESC__", esc(h["desc"]))
                .replace("__SKILL__", esc(h["skill"]))
                .replace("__TABS__", json.dumps(h["tabs"], ensure_ascii=False)))
        with open(os.path.join(ROOT, fn), "w", encoding="utf-8", newline="\n") as f:
            f.write(html)
        print("wrote", fn)


if __name__ == "__main__":
    build()
