// Trend Insight — Cloudflare Worker
// 1) 시장 온도계: cron(매 거래일 13:00·16:00 KST)마다 코스피/코스닥 지표를 KV에 저장,
//    /data/market-gauge.json 제공, /api/refresh-gauge 수동 갱신.
// 2) Stock Cockpit(/api/cockpit/*): 종목검색·시세·일봉분석·거래량상위·정배열 스크리너.
//    PC가 꺼져 있어도 폰에서 /cockpit 접속으로 종목 분석 가능.

const R1 = v => Math.round(v * 10) / 10;
const R2 = v => Math.round(v * 100) / 100;

async function fetchIndex(symbol, count = 420) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${count}&requestType=0`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`fetch ${symbol}: HTTP ${res.status}`);
  const txt = new TextDecoder("utf-8", { fatal: false }).decode(await res.arrayBuffer());
  const rows = [];
  const re = /data="([0-9|.\-]+)"/g;
  let m;
  while ((m = re.exec(txt))) {
    const f = m[1].split("|");
    if (f.length >= 5) rows.push({ date: f[0], open: +f[1], high: +f[2], low: +f[3], close: +f[4] });
  }
  if (rows.length < 100) throw new Error(`fetch ${symbol}: rows=${rows.length}`);
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

function ema(vals, n) {
  const k = 2 / (n + 1), out = [vals[0]];
  for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[i - 1] * (1 - k));
  return out;
}

function macdOsc(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = e12.map((v, i) => v - e26[i]);
  const sig = ema(macd, 9);
  return macd.map((v, i) => v - sig[i]);
}

function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gains = 0, losses = 0, ag = null, al = null;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= n) {
      gains += g; losses += l;
      if (i === n) { ag = gains / n; al = losses / n; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    } else {
      ag = (ag * (n - 1) + g) / n;
      al = (al * (n - 1) + l) / n;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  return out;
}

function sma(series, m) {
  const out = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    const w = series.slice(Math.max(0, i - m + 1), i + 1).filter(x => x !== null);
    if (w.length === m) out[i] = w.reduce((a, b) => a + b, 0) / m;
  }
  return out;
}

function stochSlow(rows, n = 14, kS = 3, dS = 3) {
  const fast = new Array(rows.length).fill(null);
  for (let i = n - 1; i < rows.length; i++) {
    const w = rows.slice(i - n + 1, i + 1);
    const hh = Math.max(...w.map(x => x.high)), ll = Math.min(...w.map(x => x.low));
    fast[i] = hh === ll ? 50 : ((rows[i].close - ll) / (hh - ll)) * 100;
  }
  const slowK = sma(fast, kS);
  return [slowK, sma(slowK, dS)];
}

function psychological(closes, n = 10) {
  const out = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i++) {
    let ups = 0;
    for (let j = i - n + 1; j <= i; j++) if (closes[j] > closes[j - 1]) ups++;
    out[i] = (ups / n) * 100;
  }
  return out;
}

function pctRank(series, i, window = 252) {
  const lo = Math.max(0, i - window + 1);
  const w = series.slice(lo, i + 1).filter(v => v !== null);
  const v = series[i];
  if (v === null || w.length < 30) return null;
  let below = 0, eq = 0;
  for (const x of w) { if (x < v) below++; else if (x === v) eq++; }
  return ((below + 0.5 * eq) / w.length) * 100;
}

function zone(score) {
  if (score >= 75) return "과매수";
  if (score >= 60) return "과열 근접";
  if (score > 40) return "중립";
  if (score > 25) return "과매도 근접";
  return "과매도";
}

function analyze(rows) {
  const closes = rows.map(r => r.close);
  const osc = macdOsc(closes);
  const rsi = rsiSeries(closes);
  const [sk, sd] = stochSlow(rows);
  const psy = psychological(closes);

  const comp = rows.map((_, i) => {
    const mp = pctRank(osc, i);
    if (mp === null || rsi[i] === null || sk[i] === null || psy[i] === null) return null;
    return R1((mp + rsi[i] + sk[i] + psy[i]) / 4);
  });

  const snapshot = j => ({
    date: rows[j].date,
    close: R2(closes[j]),
    change_pct: R2((closes[j] / closes[j - 1] - 1) * 100),
    indicators: {
      macd_osc: R2(osc[j]),
      macd_score: R1(pctRank(osc, j)),
      rsi: R1(rsi[j]),
      stoch_k: R1(sk[j]),
      stoch_d: R1(sd[j]),
      psy: R1(psy[j]),
    },
    score: comp[j],
    zone: zone(comp[j]),
  });

  const out = snapshot(rows.length - 1);
  out.history = [];
  for (let j = Math.max(1, rows.length - 90); j < rows.length; j++)
    if (comp[j] !== null) out.history.push(snapshot(j));
  return out;
}

function kstNow() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " KST";
}

async function updateGauge(env) {
  const [kospi, kosdaq] = await Promise.all([fetchIndex("KOSPI"), fetchIndex("KOSDAQ")]);
  const data = { updated: kstNow(), kospi: analyze(kospi), kosdaq: analyze(kosdaq) };
  await env.GAUGE_KV.put("market-gauge", JSON.stringify(data));
  return data;
}

const JSON_HEADERS = {
  "content-type": "application/json;charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

/* ═══════════════════ Stock Cockpit (/api/cockpit/*) ═══════════════════ */

const CK_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "referer": "https://finance.naver.com/",
};

// ── 종목명 → 코드 검색 (네이버 자동완성) ──
async function ckSearch(q) {
  const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`;
  const r = await fetch(url, { headers: CK_HEADERS });
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const j = await r.json();
  return (j.items || [])
    .filter(x => x.category === "stock" && x.nationCode === "KOR")
    .slice(0, 8)
    .map(x => ({ code: x.code, name: x.name, market: x.typeName }));
}

// ── 일봉 OHLCV (네이버 siseJson) ──
async function ckOHLCV(code, days = 200) {
  const now = new Date(Date.now() + 9 * 3600e3);
  const end = now.toISOString().slice(0, 10).replace(/-/g, "");
  const startD = new Date(now.getTime() - (days * 1.9 + 60) * 86400e3);
  const start = startD.toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`;
  const r = await fetch(url, { headers: CK_HEADERS });
  if (!r.ok) throw new Error(`ohlcv HTTP ${r.status}`);
  const txt = (await r.text()).trim().replace(/'/g, '"');
  const arr = JSON.parse(txt);
  const rows = [];
  for (let i = 1; i < arr.length; i++) {
    const [d, o, h, l, c, v] = arr[i];
    const date = String(d);
    if (![o, h, l, c, v].every(x => Number.isFinite(Number(x)))) continue;
    rows.push({
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      open: +o, high: +h, low: +l, close: +c, volume: +v,
    });
  }
  return rows;
}

// ── 실시간 시세 (네이버 폴링) ──
async function ckQuote(code) {
  const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`;
  const r = await fetch(url, { headers: CK_HEADERS });
  if (!r.ok) throw new Error(`quote HTTP ${r.status}`);
  const j = await r.json();
  const d = j.datas && j.datas[0];
  if (!d) throw new Error("quote: no data");
  const num = x => { const n = Number(String(x ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
  // 하락(4=하한, 5=하락)이면 대비/등락률에 음수 부호 적용
  const dir = d.compareToPreviousPrice && ["4", "5"].includes(String(d.compareToPreviousPrice.code)) ? -1 : 1;
  const abs = v => (v == null ? null : Math.abs(v) * dir);
  return {
    code,
    name: d.stockName || d.nm || null,
    price: num(d.closePriceRaw ?? d.closePrice ?? d.nv),
    change: abs(num(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice ?? d.cv)),
    change_rate: abs(num(d.fluctuationsRatioRaw ?? d.fluctuationsRatio ?? d.cr)),
    volume: num(d.accumulatedTradingVolumeRaw ?? d.accumulatedTradingVolume ?? d.aq),
    market_status: d.marketStatus || d.ms || null,
  };
}

// 폴링 API 실패/차단 시: 일봉 마지막 2봉으로 시세 구성 + 자동완성으로 종목명 조회
async function ckQuoteFallback(code, rows) {
  const n = rows.length;
  const last = rows[n - 1], prev = rows[n - 2];
  let name = null;
  try {
    const items = await ckSearch(code);
    const hit = items.find(x => x.code === code) || items[0];
    if (hit) name = hit.name;
  } catch (e) { /* 이름 조회 실패 허용 */ }
  const change = prev ? last.close - prev.close : null;
  return {
    code, name,
    price: last.close,
    change,
    change_rate: change != null && prev.close ? R2((change / prev.close) * 100) : null,
    volume: last.volume,
    market_status: null,
    as_of: last.date,
  };
}

// ── 글로벌 지수 (Yahoo) ──
async function ckIndex(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=10d&interval=1d`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()).chart.result[0];
  const m = j.meta;
  const closes = (j.indicators.quote[0].close || []).filter(c => c != null);
  const price = m.regularMarketPrice ?? (closes.length ? closes[closes.length - 1] : null);
  const prev = closes.length >= 2 ? closes[closes.length - 2] : m.chartPreviousClose;
  const chg = price != null && prev != null ? price - prev : null;
  const rate = chg != null && prev ? (chg / prev) * 100 : null;
  return { symbol, price: price != null ? R2(price) : null, change: chg != null ? R2(chg) : null, change_rate: rate != null ? R2(rate) : null };
}

async function ckIndices() {
  const syms = { "코스피": "^KS11", "코스닥": "^KQ11", "나스닥": "^IXIC", "원/달러": "KRW=X" };
  const out = {};
  await Promise.all(Object.entries(syms).map(async ([label, sym]) => {
    try { out[label] = await ckIndex(sym); }
    catch (e) { out[label] = { error: String(e).slice(0, 40) }; }
  }));
  return out;
}

// ── 기술적 지표 분석 (indicators.py 포팅) ──
function ckMA(closes, p) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= p) sum -= closes[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function ckMACD(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = ef.map((v, i) => v - es[i]);
  const sig = ema(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return [line, sig, hist];
}

function ckMid(rows, period) {
  const out = new Array(rows.length).fill(null);
  for (let i = period - 1; i < rows.length; i++) {
    const w = rows.slice(i - period + 1, i + 1);
    out[i] = (Math.max(...w.map(x => x.high)) + Math.min(...w.map(x => x.low))) / 2;
  }
  return out;
}

function ckIchimoku(rows, conv = 9, base = 26, spanB = 52, shift = 26) {
  const tenkan = ckMid(rows, conv), kijun = ckMid(rows, base), midB = ckMid(rows, spanB);
  const n = rows.length;
  const senkouA = new Array(n).fill(null), senkouB = new Array(n).fill(null);
  for (let i = shift; i < n; i++) {
    const t = tenkan[i - shift], k = kijun[i - shift];
    if (t != null && k != null) senkouA[i] = (t + k) / 2;
    if (midB[i - shift] != null) senkouB[i] = midB[i - shift];
  }
  return { tenkan, kijun, senkouA, senkouB };
}

function ckAnalyze(rows) {
  const periods = [5, 20, 60, 120];
  const closes = rows.map(r => r.close);
  const n = rows.length;
  const cur = closes[n - 1];
  const mas = {};
  for (const p of periods) mas[p] = ckMA(closes, p);
  const maNow = {};
  for (const p of periods) maNow[p] = mas[p][n - 1];

  const ladder = [cur, ...periods.map(p => maNow[p])];
  let steps = 0;
  for (let i = 0; i < ladder.length - 1; i++)
    if (ladder[i] != null && ladder[i + 1] != null && ladder[i] > ladder[i + 1]) steps++;
  const jby = steps === ladder.length - 1;

  const [mLine, mSig, mHist] = ckMACD(closes);
  const mNow = mLine[n - 1], sNow = mSig[n - 1], mPrev = mLine[n - 2], sPrev = mSig[n - 2];

  const ich = ckIchimoku(rows);
  const tNow = ich.tenkan[n - 1], kNow = ich.kijun[n - 1];
  const saNow = ich.senkouA[n - 1], sbNow = ich.senkouB[n - 1];
  const cloudVals = [saNow, sbNow].filter(v => v != null);
  const cloudTop = cloudVals.length ? Math.max(...cloudVals) : null;
  const cloudBot = cloudVals.length ? Math.min(...cloudVals) : null;

  const out = {
    bars: n,
    price: cur,
    ma: Object.fromEntries(periods.map(p => [p, maNow[p] != null ? R2(maNow[p]) : null])),
    jeongbaeyeol: jby,
    jby_steps: `${steps}/${ladder.length - 1}`,
    macd: {
      macd: R2(mNow), signal: R2(sNow), hist: R2(mHist[n - 1]),
      above_signal: mNow > sNow,
      golden_cross: mNow > sNow && mPrev <= sPrev,
      dead_cross: mNow < sNow && mPrev >= sPrev,
    },
    ichimoku: {
      tenkan: tNow != null ? R1(tNow) : null,
      kijun: kNow != null ? R1(kNow) : null,
      cloud_top: cloudTop != null ? R1(cloudTop) : null,
      cloud_bot: cloudBot != null ? R1(cloudBot) : null,
      above_cloud: cloudTop != null && cur > cloudTop,
      tenkan_over_kijun: tNow != null && kNow != null && tNow > kNow,
    },
  };
  const score = [out.jeongbaeyeol, out.macd.above_signal, out.ichimoku.above_cloud, out.ichimoku.tenkan_over_kijun]
    .reduce((a, b) => a + (b ? 1 : 0), 0);
  out.score = score;
  out.verdict = score >= 3 ? "강세" : score === 2 ? "중립" : "약세";
  return out;
}

function ckChart(rows, last = 120) {
  const periods = [5, 20, 60, 120];
  const closes = rows.map(r => r.close);
  const mas = {};
  for (const p of periods) mas[p] = ckMA(closes, p);
  const [mLine, mSig, mHist] = ckMACD(closes);
  const ich = ckIchimoku(rows);
  const tail = arr => arr.slice(-last).map(v => (v == null || !Number.isFinite(v) ? null : R2(v)));
  return {
    date: rows.slice(-last).map(r => r.date),
    open: tail(rows.map(r => r.open)), high: tail(rows.map(r => r.high)),
    low: tail(rows.map(r => r.low)), close: tail(closes), volume: tail(rows.map(r => r.volume)),
    ma: Object.fromEntries(periods.map(p => [String(p), tail(mas[p])])),
    macd: tail(mLine), signal: tail(mSig), hist: tail(mHist),
    senkou_a: tail(ich.senkouA), senkou_b: tail(ich.senkouB),
    tenkan: tail(ich.tenkan), kijun: tail(ich.kijun),
  };
}

async function ckAnalyzeFull(code) {
  const rows = await ckOHLCV(code, 200);
  if (rows.length < 120) return { ok: false, error: "120봉 미만(상장초기 종목)" };
  let quote = null;
  try { quote = await ckQuote(code); } catch (e) { /* 시세 실패해도 분석은 제공 */ }
  if (!quote || quote.price == null) {
    try { quote = await ckQuoteFallback(code, rows); } catch (e) { /* 폴백도 실패 허용 */ }
  }
  const signals = ckAnalyze(rows);
  const chart = ckChart(rows, 120);
  return { ok: true, data: { code, name: (quote && quote.name) || code, quote, signals, chart } };
}

// ── 거래량 상위 (네이버 sise_quant, EUC-KR) ──
// ETF·ETN·인버스·레버리지 등 패시브 상품 판별 (브랜드 접두어 + 키워드)
const CK_ETF_PREFIX = /^(KODEX|TIGER|RISE|ACE|SOL|PLUS|HANARO|KIWOOM|KOSEF|KBSTAR|ARIRANG|KTOP|TREX|UNICORN|TIMEFOLIO|BNK|FOCUS|1Q|WOORI|DAISHIN|마이티|마이다스|히어로즈|파워)\b/i;
const CK_ETF_KEYWORD = /(ETN|ETF|레버리지|인버스|선물|합성|액티브|채권|배당혼합|TOP\s?\d)/i;
function ckIsEtf(name) {
  return CK_ETF_PREFIX.test(name) || CK_ETF_KEYWORD.test(name);
}

async function ckRanking(market = "KOSPI", top = 10, includeEtf = false) {
  const sosok = market.toUpperCase() === "KOSDAQ" ? 1 : 0;
  const r = await fetch(`https://finance.naver.com/sise/sise_quant.naver?sosok=${sosok}`, { headers: CK_HEADERS });
  if (!r.ok) throw new Error(`ranking HTTP ${r.status}`);
  const txt = new TextDecoder("euc-kr").decode(await r.arrayBuffer());
  const out = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(txt)) && out.length < top) {
    const chunk = m[1];
    if (!chunk.includes('class="tltle"')) continue;
    const codeM = chunk.match(/code=(\d{6})/);
    const nameM = chunk.match(/class="tltle"[^>]*>([^<]+)</);
    if (!codeM || !nameM) continue;
    if (!includeEtf && ckIsEtf(nameM[1].trim())) continue;
    const tds = [...chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(x => x[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
    out.push({
      code: codeM[1], name: nameM[1].trim(),
      price: tds[2] || "", change_rate: tds[4] || "", volume: tds[5] || "",
      market: market.toUpperCase(),
    });
  }
  if (!out.length) throw new Error("ranking: parse 0 rows");
  return out;
}

// ── 스크리너: 거래량 상위 + 정배열 (screener.py 포팅) ──
async function ckScreen(market = "KOSPI", top = 10, onlyJby = false) {
  const ranking = await ckRanking(market, top);
  const results = await Promise.all(ranking.map(async item => {
    const row = {
      code: item.code, name: item.name, market: item.market,
      rank_price: item.price, rank_volume: item.volume, change_rate: item.change_rate,
    };
    try {
      const rows = await ckOHLCV(item.code, 130);
      if (rows.length < 120) { row.error = "120봉 부족(상장초기)"; row.score = -1; }
      else {
        const a = ckAnalyze(rows);
        Object.assign(row, {
          price: a.price, jeongbaeyeol: a.jeongbaeyeol, jby_steps: a.jby_steps,
          macd_gc: a.macd.golden_cross, macd_above: a.macd.above_signal,
          above_cloud: a.ichimoku.above_cloud, score: a.score, verdict: a.verdict,
        });
      }
    } catch (e) { row.error = String(e).slice(0, 60); row.score = -1; }
    return row;
  }));
  let rows = results;
  if (onlyJby) rows = rows.filter(r => r.jeongbaeyeol);
  rows.sort((a, b) => ((b.jeongbaeyeol ? 1 : 0) - (a.jeongbaeyeol ? 1 : 0)) || ((b.score ?? -1) - (a.score ?? -1)));
  return rows;
}

// ── 캐시 헬퍼 (Cloudflare edge cache) ──
async function ckCached(req, ttl, fn) {
  const cache = caches.default;
  const key = new Request(new URL(req.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const data = await fn();
  const res = new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": `public, s-maxage=${ttl}`,
      "access-control-allow-origin": "*",
    },
  });
  try { await cache.put(key, res.clone()); } catch (e) { /* cache 실패 무시 */ }
  return res;
}

async function handleCockpit(req, url, ctx) {
  const p = url.pathname.slice("/api/cockpit/".length);
  const wrap = data => ({ ok: true, data });
  try {
    if (p === "search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return new Response(JSON.stringify({ ok: true, data: [] }), { headers: JSON_HEADERS });
      return await ckCached(req, 21600, async () => wrap(await ckSearch(q)));
    }
    if (p === "indices") return await ckCached(req, 60, async () => wrap(await ckIndices()));
    if (p.startsWith("quote/")) {
      const code = p.slice(6).replace(/[^0-9A-Za-z]/g, "");
      return await ckCached(req, 20, async () => {
        try {
          const q = await ckQuote(code);
          if (q.price != null) return wrap(q);
        } catch (e) { /* 폴백으로 진행 */ }
        return wrap(await ckQuoteFallback(code, await ckOHLCV(code, 10)));
      });
    }
    if (p.startsWith("analyze/")) {
      const code = p.slice(8).replace(/[^0-9A-Za-z]/g, "");
      return await ckCached(req, 180, async () => await ckAnalyzeFull(code));
    }
    if (p === "ranking") {
      const market = url.searchParams.get("market") || "KOSPI";
      const top = Math.min(parseInt(url.searchParams.get("top") || "10", 10) || 10, 30);
      const inclEtf = url.searchParams.get("etf") === "1";
      return await ckCached(req, 60, async () => wrap(await ckRanking(market, top, inclEtf)));
    }
    if (p === "screener") {
      const market = url.searchParams.get("market") || "KOSPI";
      const top = Math.min(parseInt(url.searchParams.get("top") || "10", 10) || 10, 20);
      const jby = url.searchParams.get("jby") === "1";
      return await ckCached(req, 120, async () => wrap(await ckScreen(market, top, jby)));
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404, headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: JSON_HEADERS });
  }
}


/* ═══════════════ Risk Manager API (리스크 계기판) ═══════════════ */

async function rkSha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rkState(env) {
  const [rules, meta, holdings] = await Promise.all([
    env.RISK_DB.prepare("SELECT key,value,label,updated_at FROM rules").all(),
    env.RISK_DB.prepare("SELECT key,value FROM meta WHERE key!='sync_token_hash'").all(),
    env.RISK_DB.prepare("SELECT code,name,accounts,qty,buy_amount,eval_amount,pl,ret,weight,updated_at FROM holdings ORDER BY eval_amount DESC").all(),
  ]);
  const r = {}; for (const x of rules.results) r[x.key] = { value: x.value, label: x.label, updated_at: x.updated_at };
  const m = {}; for (const x of meta.results) m[x.key] = x.value;
  return { rules: r, meta: m, holdings: holdings.results, count: holdings.results.length };
}

async function handleRisk(req, url, env) {
  try {
    const p = url.pathname.slice("/api/risk/".length);
    if (p === "state" && req.method === "GET") {
      return new Response(JSON.stringify({ ok: true, data: await rkState(env) }), { headers: JSON_HEADERS });
    }
    if (p === "quotes" && req.method === "GET") {
      const codes = (url.searchParams.get("codes") || "").split(",")
        .map((c) => c.replace(/[^0-9A-Za-z]/g, "")).filter(Boolean).slice(0, 40);
      const out = {};
      await Promise.all(codes.map(async (c) => {
        try { const q = await ckQuote(c); out[c] = { price: q.price, change_rate: q.change_rate, name: q.name }; }
        catch (e) { out[c] = null; }
      }));
      return new Response(JSON.stringify({ ok: true, data: out }), { headers: JSON_HEADERS });
    }
    if (p === "sync" && req.method === "POST") {
      const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const row = await env.RISK_DB.prepare("SELECT value FROM meta WHERE key='sync_token_hash'").first();
      if (!row || !auth || (await rkSha256(auth)) !== row.value)
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
      const body = await req.json();
      const now = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
      const stmts = [];
      if (Array.isArray(body.holdings)) {
        stmts.push(env.RISK_DB.prepare("DELETE FROM holdings"));
        for (const h of body.holdings)
          stmts.push(env.RISK_DB.prepare("INSERT INTO holdings VALUES(?,?,?,?,?,?,?,?,?,?)")
            .bind(String(h.code), h.name ?? null, h.accounts ?? null, h.qty ?? null, h.buy_amount ?? null,
                  h.eval_amount ?? null, h.pl ?? null, h.ret ?? null, h.weight ?? null, now));
      }
      if (body.meta && typeof body.meta === "object")
        for (const [k, v] of Object.entries(body.meta))
          if (k !== "sync_token_hash")
            stmts.push(env.RISK_DB.prepare("INSERT OR REPLACE INTO meta VALUES(?,?,?)").bind(k, String(v), now));
      if (body.rules && typeof body.rules === "object")
        for (const [k, v] of Object.entries(body.rules))
          stmts.push(env.RISK_DB.prepare("UPDATE rules SET value=?, updated_at=? WHERE key=?").bind(Number(v), now, k));
      if (stmts.length) await env.RISK_DB.batch(stmts);
      return new Response(JSON.stringify({ ok: true, holdings: Array.isArray(body.holdings) ? body.holdings.length : 0 }), { headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404, headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
  }
}


/* ═══════════════ Stop-Loss Radar (/api/stoploss/*) ═══════════════
   5가지 매도 기준(50일선 붕괴·시장 천장·분산일·클라이맥스 탑·트레일링 스탑)
   + 리스크 규정 손절선(매입가 대비 -stop_loss_pct%)으로 보유종목을
   SELL/WATCH/HOLD 판정. 크론이 상위 N종목을 자동 점검해 KV에 저장하고
   신규 SELL/WATCH 신호를 텔레그램으로 알린다. */

const SL = {
  BARS: 280,               // 조회 봉 수 (MA50·52주 고가·분산일 계산용)
  DIST_WINDOW: 25,         // 분산일 카운트 윈도우 (거래일)
  DIST_STOCK_TH: 5,        // 종목 분산일 경고 임계
  DIST_MKT_TH: 5,          // 지수 분산일 시장 천장 임계
  DIST_MKT_CAUTION: 3,     // 지수 분산일 주의 임계
  VOL_SPIKE: 1.5,          // 50일 평균 대비 대량 거래 배수
  TRAIL_PCT: 15,           // 트레일링 스탑 기본 %
  CLIMAX_RUNUP: 25,        // 클라이맥스: 10거래일 상승률 임계 %
  RSI_OVERHEAT: 80,
  AUTO_TOP_N: 40,          // 크론 자동 점검: 평가금액 상위 N
  SCAN_LIMIT: 20,          // /scan 청크 최대 종목 수 (서브리퀘스트 한도 보호)
};

// fchart — 지수·종목 공용 일봉 (거래량 포함, 요청 1회)
async function slBars(symbol, count = SL.BARS) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${count}&requestType=0`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`fchart ${symbol}: HTTP ${res.status}`);
  const txt = new TextDecoder("utf-8", { fatal: false }).decode(await res.arrayBuffer());
  const rows = [];
  const re = /data="([0-9|.\-]+)"/g;
  let m;
  while ((m = re.exec(txt))) {
    const f = m[1].split("|");
    if (f.length >= 6)
      rows.push({ date: f[0], open: +f[1], high: +f[2], low: +f[3], close: +f[4], volume: +f[5] });
  }
  if (rows.length < 60) throw new Error(`fchart ${symbol}: rows=${rows.length}`);
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

// 최근 window 거래일 중 분산일(하락 -0.2% 이상 + 거래량 전일 대비 증가) 수
function slDistributionDays(rows, window = SL.DIST_WINDOW) {
  let cnt = 0;
  const n = rows.length;
  for (let i = Math.max(1, n - window); i < n; i++) {
    const chg = (rows[i].close / rows[i - 1].close - 1) * 100;
    if (chg <= -0.2 && rows[i].volume > rows[i - 1].volume) cnt++;
  }
  return cnt;
}

function slMA(vals, p, idx) {
  if (idx == null) idx = vals.length - 1;
  if (idx + 1 < p) return null;
  let s = 0;
  for (let i = idx - p + 1; i <= idx; i++) s += vals[i];
  return s / p;
}

// ── 시장 판정 (기준 2: 시장 천장) ──
async function slMarket() {
  const out = {};
  for (const mkt of ["KOSPI", "KOSDAQ"]) {
    try {
      const rows = await slBars(mkt);
      const closes = rows.map(r => r.close);
      const ma50 = slMA(closes, 50);
      const dist = slDistributionDays(rows);
      const below = closes[closes.length - 1] < ma50;
      const status = dist >= SL.DIST_MKT_TH || below ? "천장/조정 신호"
        : dist >= SL.DIST_MKT_CAUTION ? "주의" : "정상";
      out[mkt] = {
        date: rows[rows.length - 1].date,
        close: R2(closes[closes.length - 1]),
        ma50: R2(ma50),
        below_ma50: below,
        distribution_days: dist,
        status,
      };
    } catch (e) { out[mkt] = { status: "조회 실패", error: String(e).slice(0, 60) }; }
  }
  const st = [out.KOSPI?.status || "", out.KOSDAQ?.status || ""];
  out.overall = st.some(s => s.includes("천장")) ? "RISK_OFF"
    : st.some(s => s === "주의") ? "CAUTION" : "NORMAL";
  return out;
}

// ── 종목 판정 (기준 1·3·4·5 + 규정 손절선) ──
function slAnalyzeStock(rows, holding, marketOverall, trailPct, stopLossPct) {
  const n = rows.length;
  const closes = rows.map(r => r.close);
  const vols = rows.map(r => r.volume);
  const last = rows[n - 1], prev = rows[n - 2] || last;
  const price = last.close;
  const signals = [];
  let score = 0;
  const won = v => Math.round(v).toLocaleString("ko-KR");

  // 1. 50일선 붕괴
  const ma50 = slMA(closes, 50);
  const vol50 = slMA(vols, 50);
  if (ma50 != null) {
    const below = price < ma50;
    const volSpike = vol50 != null && last.volume >= vol50 * SL.VOL_SPIKE;
    let daysBelow = 0;
    for (let i = 1; i <= Math.min(n - 50, 15); i++) {
      const m = slMA(closes, 50, n - i);
      if (m != null && closes[n - i] < m) daysBelow++; else break;
    }
    if (below && (volSpike || daysBelow >= 2)) {
      const tag = volSpike ? "대량 거래 동반" : `${daysBelow}일 연속`;
      signals.push(["CRIT", "MA50_BREAK", `50일선 붕괴(${tag}) — 종가 ${won(price)} < MA50 ${won(ma50)}`]);
      score += 40;
    } else if (below) {
      signals.push(["WARN", "MA50_BELOW", `50일선 이탈(첫날·거래량 미동반) — 종가 ${won(price)} < MA50 ${won(ma50)}`]);
      score += 20;
    }
  }

  // 3. 종목 분산일
  const dist = slDistributionDays(rows);
  if (dist >= SL.DIST_STOCK_TH) {
    signals.push(["WARN", "DISTRIBUTION", `최근 ${SL.DIST_WINDOW}일 분산일 ${dist}회 — 기관 매도 흔적`]);
    score += 15;
  } else if (dist >= SL.DIST_STOCK_TH - 1) {
    signals.push(["INFO", "DISTRIBUTION", `분산일 ${dist}회 — 임계 근접`]);
    score += 5;
  }

  // 4. 클라이맥스 탑 / 과열
  const tail250 = rows.slice(-250);
  const high52 = Math.max(...tail250.map(r => r.high));
  const nearHigh = price >= high52 * 0.9;
  const runup10 = n > 11 ? (price / closes[n - 11] - 1) * 100 : 0;
  const rsiArr = rsiSeries(closes);
  const rsi14 = rsiArr[n - 1] != null ? rsiArr[n - 1] : 50;
  const exhaustGap = last.open > prev.high && price < last.open && nearHigh;
  if (nearHigh && runup10 >= SL.CLIMAX_RUNUP && rsi14 >= SL.RSI_OVERHEAT) {
    signals.push(["CRIT", "CLIMAX", `클라이맥스 탑 의심 — 10일 +${R1(runup10)}%, RSI ${Math.round(rsi14)}, 고점권`]);
    score += 30;
  } else if (exhaustGap) {
    signals.push(["WARN", "EXHAUST_GAP", "소진 갭 — 고점권 갭업 후 시가 아래 마감"]);
    score += 15;
  } else if (nearHigh && (runup10 >= SL.CLIMAX_RUNUP || rsi14 >= SL.RSI_OVERHEAT)) {
    signals.push(["INFO", "OVERHEAT", `과열 주의 — 10일 +${R1(runup10)}%, RSI ${Math.round(rsi14)}`]);
    score += 5;
  }

  // 5. 트레일링 스탑 (52주 최고 종가 기준)
  const peak = Math.max(...tail250.map(r => r.close));
  const drawdown = (1 - price / peak) * 100;
  if (drawdown >= trailPct) {
    signals.push(["CRIT", "TRAIL_STOP", `트레일링 스탑 — 고점 ${won(peak)} 대비 -${R1(drawdown)}% (임계 ${trailPct}%)`]);
    score += 35;
  } else if (drawdown >= trailPct * 0.8) {
    signals.push(["WARN", "TRAIL_NEAR", `트레일링 근접 — 고점 대비 -${R1(drawdown)}%`]);
    score += 15;
  }

  // 규정 손절선 (리스크 규정 §2.1: 매입가 대비 -stop_loss_pct%)
  const buyPrice = holding.buy_price || null;
  let pnl = null;
  if (buyPrice) {
    pnl = (price / buyPrice - 1) * 100;
    if (stopLossPct && pnl <= -stopLossPct) {
      signals.push(["CRIT", "STOP_PRICE", `규정 손절선 이탈 — 매입가 ${won(buyPrice)} 대비 ${R1(pnl)}% (규정 -${stopLossPct}%)`]);
      score += 40;
    }
  }

  // 시장 국면 반영 (기준 2)
  let nCrit = signals.filter(s => s[0] === "CRIT").length;
  const nWarn = signals.filter(s => s[0] === "WARN").length;
  if (marketOverall === "RISK_OFF") {
    score = Math.round(score * 1.25);
    if (nCrit === 0 && nWarn >= 2) {
      signals.push(["CRIT", "MARKET_TOP", "시장 천장 국면 — 복수 경고 신호로 손절 후보 승격"]);
      nCrit++;
    }
  } else if (marketOverall === "CAUTION" && nWarn >= 1) {
    signals.push(["INFO", "MARKET_CAUTION", "시장 주의 국면 — 경고 신호 주시"]);
  }

  const verdict = nCrit >= 1 ? "SELL" : nWarn >= 1 ? "WATCH" : "HOLD";
  return {
    code: holding.code,
    name: holding.name || holding.code,
    weight: holding.weight != null ? R2(holding.weight * 100) : null,
    date: last.date,
    price,
    ma50: ma50 != null ? Math.round(ma50) : null,
    pct_vs_ma50: ma50 != null ? R1((price / ma50 - 1) * 100) : null,
    rsi14: R1(rsi14),
    distribution_days: dist,
    drawdown_from_peak: R1(drawdown),
    pnl_pct: pnl != null ? R1(pnl) : null,
    verdict, score,
    signals: signals.map(([grade, code2, msg]) => ({ grade, code: code2, msg })),
  };
}

async function slHoldings(env, offset = 0, limit = SL.AUTO_TOP_N) {
  const q = await env.RISK_DB.prepare(
    "SELECT code,name,qty,buy_amount,eval_amount,weight FROM holdings ORDER BY eval_amount DESC LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();
  return q.results.map(h => ({
    code: String(h.code).padStart(6, "0"),
    name: h.name,
    weight: h.weight,
    buy_price: h.qty > 0 && h.buy_amount > 0 ? h.buy_amount / h.qty : null,
  }));
}

async function slStopLossPct(env) {
  try {
    const r = await env.RISK_DB.prepare("SELECT value FROM rules WHERE key='stop_loss_pct'").first();
    return r ? Number(r.value) : null;
  } catch (e) { return null; }
}

async function slScanList(env, holdings, market, trailPct) {
  const stopLossPct = await slStopLossPct(env);
  const settled = await Promise.all(holdings.map(async h => {
    try {
      const rows = await slBars(h.code);
      if (rows.length < 60) return { code: h.code, name: h.name, error: "60봉 미만(상장초기)" };
      return slAnalyzeStock(rows, h, market.overall, trailPct, stopLossPct);
    } catch (e) { return { code: h.code, name: h.name, error: String(e).slice(0, 60) }; }
  }));
  const ORD = { SELL: 0, WATCH: 1, HOLD: 2 };
  settled.sort((a, b) => ((ORD[a.verdict] ?? 3) - (ORD[b.verdict] ?? 3)) || ((b.score ?? -1) - (a.score ?? -1)));
  return settled;
}

// ── 텔레그램 알림 ──
async function slTelegram(env, text) {
  const rows = await env.RISK_DB.prepare("SELECT key,value FROM secrets WHERE key IN ('telegram_bot_token','telegram_chat_id')").all();
  const cfg = {};
  for (const r of rows.results) cfg[r.key] = r.value;
  if (!cfg.telegram_bot_token || !cfg.telegram_chat_id) return false;
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegram_bot_token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.telegram_chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return res.ok;
}

const SL_VLABEL = { SELL: "즉시 손절 후보", WATCH: "경고(감시)", HOLD: "유지" };

// ── 자동 점검(크론·수동 refresh 공용): 상위 N 스캔 → KV 저장 → 신규 신호 알림 ──
async function slRefresh(env, { notify = false, topN = SL.AUTO_TOP_N, trailPct = SL.TRAIL_PCT, session = "close" } = {}) {
  const market = await slMarket();
  const holdings = await slHoldings(env, 0, topN);
  const results = await slScanList(env, holdings, market, trailPct);

  // 이전 결과와 비교해 신규/승격 신호 검출
  let prevMap = {};
  try {
    const prev = JSON.parse((await env.GAUGE_KV.get("stoploss-result")) || "null");
    if (prev && Array.isArray(prev.results))
      for (const r of prev.results) if (r.verdict) prevMap[r.code] = r.verdict;
  } catch (e) { /* 무시 */ }
  const RANK = { HOLD: 0, WATCH: 1, SELL: 2 };
  const escalated = results.filter(r =>
    r.verdict && (r.verdict === "SELL" || r.verdict === "WATCH") &&
    (RANK[r.verdict] > (RANK[prevMap[r.code]] ?? 0)));

  const data = {
    updated: kstNow(),
    session,                         // "intraday"(13시) | "close"(16시) | "manual"
    as_of: market.KOSPI?.date || null,
    trail_pct: trailPct,
    scope: { top_n: topN, total: (await env.RISK_DB.prepare("SELECT COUNT(*) n FROM holdings").first()).n },
    market,
    results,
  };
  await env.GAUGE_KV.put("stoploss-result", JSON.stringify(data));

  if (notify && escalated.length) {
    const mkLine = r => {
      const sigs = r.signals.filter(s => s.grade !== "INFO").map(s => "· " + s.msg).join("\n");
      const icon = r.verdict === "SELL" ? "🔴" : "🟡";
      return `${icon} <b>${r.name}</b>(${r.code}) — ${SL_VLABEL[r.verdict]}` +
        (r.pnl_pct != null ? ` (손익 ${r.pnl_pct > 0 ? "+" : ""}${r.pnl_pct}%)` : "") + "\n" + sigs;
    };
    const head = session === "intraday" ? "📡 손절 레이더 (장중 참고)" : "📡 손절 레이더 (종가 확정)";
    const mktLine = `시장: ${market.overall === "RISK_OFF" ? "⚠️ 시장 천장/조정 신호" : market.overall === "CAUTION" ? "주의" : "정상"}`;
    const text = [head, mktLine, "", ...escalated.slice(0, 10).map(mkLine),
      escalated.length > 10 ? `…외 ${escalated.length - 10}종목` : "",
      "", "https://trend-insight-site.sungsangkyung77.workers.dev/stoploss.html"].filter(Boolean).join("\n");
    try { await slTelegram(env, text); } catch (e) { /* 알림 실패는 무시 */ }
  }
  return { data, escalated: escalated.length };
}

async function handleStopLoss(req, url, env) {
  const p = url.pathname.slice("/api/stoploss/".length);
  try {
    if (p === "market") {
      return new Response(JSON.stringify({ ok: true, data: await slMarket() }), { headers: JSON_HEADERS });
    }
    if (p === "scan") {
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, SL.SCAN_LIMIT);
      const trailPct = Math.min(Math.max(parseFloat(url.searchParams.get("trail") || SL.TRAIL_PCT) || SL.TRAIL_PCT, 5), 40);
      const overall = ["NORMAL", "CAUTION", "RISK_OFF"].includes(url.searchParams.get("regime"))
        ? url.searchParams.get("regime") : null;
      const market = overall ? { overall } : await slMarket();
      const total = (await env.RISK_DB.prepare("SELECT COUNT(*) n FROM holdings").first()).n;
      const holdings = await slHoldings(env, offset, limit);
      const results = await slScanList(env, holdings, market, trailPct);
      return new Response(JSON.stringify({ ok: true, data: { total, offset, count: holdings.length, market, results } }), { headers: JSON_HEADERS });
    }
    if (p === "refresh") {
      const topN = Math.min(parseInt(url.searchParams.get("n") || SL.AUTO_TOP_N, 10) || SL.AUTO_TOP_N, SL.AUTO_TOP_N);
      const trailPct = Math.min(Math.max(parseFloat(url.searchParams.get("trail") || SL.TRAIL_PCT) || SL.TRAIL_PCT, 5), 40);
      const notify = url.searchParams.get("notify") === "1";
      const { data, escalated } = await slRefresh(env, { notify, topN, trailPct, session: "manual" });
      return new Response(JSON.stringify({
        ok: true, updated: data.updated, market: data.market.overall,
        sell: data.results.filter(r => r.verdict === "SELL").length,
        watch: data.results.filter(r => r.verdict === "WATCH").length,
        escalated,
      }), { headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404, headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: JSON_HEADERS });
  }
}

/* ═══════════════════════════════════════════════════════════════════ */

export default {
  async scheduled(event, env, ctx) {
    // UTC 4시 = 13:00 KST(장중 참고) / UTC 7시 = 16:00 KST(종가 확정)
    const utcH = new Date().getUTCHours();
    const session = utcH < 6 ? "intraday" : "close";
    ctx.waitUntil(updateGauge(env));
    ctx.waitUntil(slRefresh(env, { notify: true, session }));
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/risk/")) {
      return handleRisk(req, url, env);
    }

    if (url.pathname.startsWith("/api/stoploss/")) {
      return handleStopLoss(req, url, env);
    }

    if (url.pathname === "/data/stoploss.json") {
      const v = await env.GAUGE_KV.get("stoploss-result");
      return new Response(v || JSON.stringify({ ok: false, error: "아직 점검 결과가 없습니다. 새로 점검을 실행하세요." }),
        { headers: JSON_HEADERS });
    }

    if (url.pathname.startsWith("/api/cockpit/")) {
      return handleCockpit(req, url, ctx);
    }

    if (url.pathname === "/api/refresh-gauge") {
      try {
        const d = await updateGauge(env);
        return new Response(JSON.stringify({
          ok: true, updated: d.updated, as_of: d.kospi.date,
          kospi: { score: d.kospi.score, zone: d.kospi.zone },
          kosdaq: { score: d.kosdaq.score, zone: d.kosdaq.zone },
        }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    if (url.pathname === "/data/market-gauge.json") {
      const v = await env.GAUGE_KV.get("market-gauge");
      if (v) return new Response(v, { headers: JSON_HEADERS });
    }

    return env.ASSETS.fetch(req);
  },
};
