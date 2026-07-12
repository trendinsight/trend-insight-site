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
  const signals = ckAnalyze(rows);
  const chart = ckChart(rows, 120);
  return { ok: true, data: { code, name: (quote && quote.name) || code, quote, signals, chart } };
}

// ── 거래량 상위 (네이버 sise_quant, EUC-KR) ──
async function ckRanking(market = "KOSPI", top = 10) {
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
      return await ckCached(req, 20, async () => wrap(await ckQuote(code)));
    }
    if (p.startsWith("analyze/")) {
      const code = p.slice(8).replace(/[^0-9A-Za-z]/g, "");
      return await ckCached(req, 180, async () => await ckAnalyzeFull(code));
    }
    if (p === "ranking") {
      const market = url.searchParams.get("market") || "KOSPI";
      const top = Math.min(parseInt(url.searchParams.get("top") || "10", 10) || 10, 30);
      return await ckCached(req, 60, async () => wrap(await ckRanking(market, top)));
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

/* ═══════════════════════════════════════════════════════════════════ */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateGauge(env));
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/cockpit/")) {
      return handleCockpit(req, url, ctx);
    }

    if (url.pathname === "/api/refresh-gauge") {
      try {
        const d = await updateGauge(env);
        return new Response(JSON.stringify({
          ok: true, updated: d.updated, as_of: d.kospi.date,
          kospi