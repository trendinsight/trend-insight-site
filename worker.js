// Trend Insight — Cloudflare Worker
// 1) 시장 온도계: cron(매 거래일 13:00·16:00 KST)마다 코스피/코스닥 + 다우/나스닥/S&P500
//    지표를 KV에 저장,
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

// 미국 지수용 — 네이버 fchart는 해외지수를 제공하지 않아 야후 파이낸스 사용.
// 반환 형식은 fetchIndex와 동일(date/open/high/low/close, 날짜 오름차순).
// 야후 일봉 타임스탬프는 현지 장 시작 시각이라 KST로 변환해도 미국 현지 거래일과 같은 날짜가 된다.
async function fetchIndexYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2y&interval=1d`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`yahoo ${symbol}: HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r || !q) throw new Error(`yahoo ${symbol}: bad payload`);
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close[i];
    if (c === null || c === undefined) continue;
    const date = new Date(r.timestamp[i] * 1000 + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
    rows.push({ date, open: q.open[i] ?? c, high: q.high[i] ?? c, low: q.low[i] ?? c, close: c });
  }
  if (rows.length < 100) throw new Error(`yahoo ${symbol}: rows=${rows.length}`);
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

/* ═══════════ 코인 온도계 자동 갱신 (업비트 KRW 일봉) ═══════════
   시장 온도계와 동일 4지표 + 다바스 60일 박스 근사 진입판정 + 김치프리미엄.
   결과는 KV "crypto-gauge" — /data/crypto-gauge.json 이 KV 우선으로 서빙. */
const CRYPTO_COINS = [
  { sym: "BTC", mkt: "KRW-BTC", usd: "BTC-USD" },
  { sym: "ETH", mkt: "KRW-ETH", usd: "ETH-USD" },
  { sym: "XRP", mkt: "KRW-XRP", usd: "XRP-USD" },
];

async function fetchUpbitDays(market, want = 420) {
  let raw = [], to = "";
  while (raw.length < want) {
    const url = `https://api.upbit.com/v1/candles/days?market=${market}&count=200${to ? `&to=${encodeURIComponent(to)}` : ""}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`upbit ${market}: HTTP ${res.status}`);
    const j = await res.json();
    if (!j.length) break;
    raw = raw.concat(j);
    to = j[j.length - 1].candle_date_time_utc;
    if (j.length < 200) break;
  }
  const rows = raw.map(c => ({
    date: c.candle_date_time_kst.slice(0, 10).replace(/-/g, ""),
    open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price,
  }));
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length < 100) throw new Error(`upbit ${market}: rows=${rows.length}`);
  return rows;
}

function cryptoEntryCalc(rows) {
  const n = rows.length, closes = rows.map(r => r.close);
  const last = rows[n - 1], close = last.close;
  const maAt = (p, endIdx) => {
    if (endIdx + 1 < p) return null;
    let s = 0; for (let i = endIdx - p + 1; i <= endIdx; i++) s += closes[i];
    return s / p;
  };
  const ma50 = maAt(50, n - 1), ma150 = maAt(150, n - 1), ma200 = maAt(200, n - 1);
  const ma200p = maAt(200, n - 21);
  const yr = rows.slice(-252);
  const hi52 = Math.max(...yr.map(r => r.high)), lo52 = Math.min(...yr.map(r => r.low));
  const conds = [
    ma50 !== null && close > ma50,
    ma150 !== null && close > ma150,
    ma200 !== null && close > ma200,
    ma150 !== null && ma200 !== null && ma150 > ma200,
    ma200 !== null && ma200p !== null && ma200 > ma200p,
    close >= lo52 * 1.3,
    close >= hi52 * 0.75,
  ];
  const tt = conds.filter(Boolean).length;
  let trs = [];
  for (let i = Math.max(1, n - 20); i < n; i++) {
    trs.push(Math.max(rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close), Math.abs(rows[i].low - rows[i - 1].close)));
  }
  const N = trs.reduce((a, b) => a + b, 0) / trs.length;
  const box = rows.slice(-61, -1);
  const pivot = Math.max(...box.map(r => r.high));
  const dist = (close / pivot - 1) * 100;
  let verdict = "NO_SETUP";
  if (tt >= 5 && dist > 0 && dist <= 3) verdict = "BUY_POINT";
  else if (tt >= 5 && dist > -8 && dist <= 0) verdict = "SETUP";
  else if (dist > 3) verdict = "EXTENDED";
  return {
    verdict, pattern: "BOX60", pivot: Math.round(pivot),
    dist_to_pivot_pct: R1(dist), tt_passed: tt, tt_total: 7,
    stop: Math.round(close - 2 * N),
  };
}

async function updateCryptoGauge(env) {
  let data = null;
  try { data = JSON.parse((await env.GAUGE_KV.get("crypto-gauge")) || "null"); } catch (e) { data = null; }
  if (!data) {
    try {
      const r = await env.ASSETS.fetch("https://seed/data/crypto-gauge.json");
      if (r.ok) data = await r.json();
    } catch (e) { /* seed 없음 */ }
  }
  if (!data || !data.coins) data = { coins: {} };

  let usdkrw = null;
  try { const fx = await fetchIndexYahoo("KRW=X"); usdkrw = fx[fx.length - 1].close; } catch (e) { /* 김프 생략 */ }

  const failed = [];
  for (const c of CRYPTO_COINS) {
    try {
      const rows = await fetchUpbitDays(c.mkt);
      const a = analyze(rows);
      const old = (data.coins[c.sym] && data.coins[c.sym].history) || [];
      const oldBy = {};
      old.forEach(h => { oldBy[h.date] = h; });
      const hist = a.history.map(s => {
        const o = oldBy[s.date];
        if (o) {
          if (o.kimchi_pct != null) s.kimchi_pct = o.kimchi_pct;
          if (o.entry) s.entry = o.entry;
        }
        return s;
      });
      const lastSnap = hist[hist.length - 1];
      lastSnap.entry = cryptoEntryCalc(rows);
      if (usdkrw) {
        try {
          const r = await fetch(`https://api.coinbase.com/v2/prices/${c.usd}/spot`, { headers: { accept: "application/json" } });
          if (r.ok) {
            const usd = parseFloat((await r.json()).data.amount);
            if (usd > 0) lastSnap.kimchi_pct = R2((rows[rows.length - 1].close / (usd * usdkrw) - 1) * 100);
          }
        } catch (e) { /* 김프 생략 */ }
      }
      const merged = old.filter(h => !hist.some(s => s.date === h.date)).concat(hist);
      merged.sort((x, y) => (x.date < y.date ? -1 : 1));
      data.coins[c.sym] = { history: merged.slice(-200) };
    } catch (e) {
      failed.push(`${c.sym}: ${String(e)}`);
    }
  }
  if (!CRYPTO_COINS.some(c => data.coins[c.sym])) throw new Error(`updateCryptoGauge 전부 실패: ${failed.join(" | ")}`);
  data.updated = kstNow();
  if (failed.length) data.warnings = failed; else delete data.warnings;
  await env.GAUGE_KV.put("crypto-gauge", JSON.stringify(data));
  return data;
}

// 지수 정의 — 국내는 네이버, 미국은 야후. 게시 순서 = 페이지 표시 순서.
const GAUGE_INDICES = [
  { key: "kospi",  src: "naver", sym: "KOSPI" },
  { key: "kosdaq", src: "naver", sym: "KOSDAQ" },
  { key: "dow",    src: "yahoo", sym: "%5EDJI" },
  { key: "nasdaq", src: "yahoo", sym: "%5EIXIC" },
  { key: "sp500",  src: "yahoo", sym: "%5EGSPC" },
];

async function updateGauge(env) {
  const settled = await Promise.allSettled(
    GAUGE_INDICES.map(ix => (ix.src === "naver" ? fetchIndex(ix.sym) : fetchIndexYahoo(ix.sym)))
  );

  // 한 지수 실패가 나머지 갱신을 막지 않도록 이전 KV 값을 남겨둔다
  let prev = null;
  try { prev = JSON.parse((await env.GAUGE_KV.get("market-gauge")) || "null"); } catch (e) { prev = null; }

  const data = { updated: kstNow() };
  const failed = [];
  GAUGE_INDICES.forEach((ix, i) => {
    const s = settled[i];
    if (s.status === "fulfilled") {
      try {
        data[ix.key] = analyze(s.value);
        return;
      } catch (e) {
        failed.push(`${ix.key}: ${String(e)}`);
      }
    } else {
      failed.push(`${ix.key}: ${String(s.reason)}`);
    }
    if (prev && prev[ix.key]) data[ix.key] = prev[ix.key]; // 직전 값 유지
  });

  if (!GAUGE_INDICES.some(ix => data[ix.key])) throw new Error(`updateGauge 전부 실패: ${failed.join(" | ")}`);
  if (failed.length) data.warnings = failed;

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

// ── 종목 온도계 (/api/cockpit/thermo/{code}) — 시장 온도계 analyze() 재사용 ──
async function ckThermo(code) {
  const rows = await fetchIndex(code, 420); // fchart는 지수·종목 코드 모두 지원
  let name = null, market = null;
  try {
    const items = await ckSearch(code);
    const hit = items.find(x => x.code === code) || items[0];
    if (hit) { name = hit.name; market = hit.market; }
  } catch (e) { /* 이름 조회 실패 허용 */ }
  const gauge = analyze(rows);
  return { code, name, market, updated: kstNow(), gauge };
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
    if (p.startsWith("thermo/")) {
      // 종목 온도계: 시장 온도계와 동일한 4지표(MACD 백분위·RSI·스토캐스틱·투자심리도)를 개별 종목에 적용
      const code = p.slice(7).replace(/[^0-9A-Za-z]/g, "");
      return await ckCached(req, 180, async () => wrap(await ckThermo(code)));
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404, headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: JSON_HEADERS });
  }
}


/* ═══════════════ Entry Timer (/api/entry/*) ═══════════════
   진입 타이밍 판정: 트렌드 템플릿(미너비니) → VCP → 다바스 박스 → 등급.
   사이징(터틀 ATR)은 자본이 필요하므로 클라이언트(entry.html)에서 계산 —
   API는 atr20을 내려준다. 로직은 entry-timer 스킬(파이썬)과 동일 기준. */

const ET_BASE_WINDOW = 65;          // VCP·박스 탐색 구간 (거래일)
const ET_SWING_WIN = 5;             // 스윙 고점 판정 좌우 봉 수
const ET_MAX_FINAL_CONTRACTION = 10.0;
const ET_VOL_DRYUP_RATIO = 0.65;
const ET_BREAKOUT_VOL_RATIO = 1.5;
const ET_CHASE_PCT = 5.0;           // 피벗 초과 추격 허용 %
const ET_NEAR_PIVOT_PCT = 12.0;     // SETUP 인정: 피벗 아래 근접 %
const ET_DARVAS_CONFIRM = 3;
const ET_ATR_PERIOD = 20;

function etSMAat(vals, n, i) {
  if (i + 1 < n || i >= vals.length || i < 0) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += vals[k];
  return s / n;
}

function etATR20(rows) {
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    trs.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close),
    ));
  }
  if (trs.length < ET_ATR_PERIOD) return null;
  const w = trs.slice(-ET_ATR_PERIOD);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

function etTrendTemplate(rows) {
  const closes = rows.map(r => r.close);
  const i = closes.length - 1;
  const c = closes[i];
  const ma50 = etSMAat(closes, 50, i), ma150 = etSMAat(closes, 150, i), ma200 = etSMAat(closes, 200, i);
  const ma200p = etSMAat(closes, 200, i - 21);
  const t = rows.slice(-252);
  const hi52 = Math.max(...t.map(r => r.high)), lo52 = Math.min(...t.map(r => r.low));
  const checks = {
    "종가>MA150·MA200": ma150 != null && ma200 != null && c > ma150 && c > ma200,
    "MA150>MA200": ma150 != null && ma200 != null && ma150 > ma200,
    "MA200 상승중(1개월)": ma200 != null && ma200p != null && ma200 > ma200p,
    "MA50>MA150>MA200": ma50 != null && ma150 != null && ma200 != null && ma50 > ma150 && ma150 > ma200,
    "종가>MA50": ma50 != null && c > ma50,
    "52주 저가 대비 +30%↑": c >= lo52 * 1.30,
    "52주 고가 -25% 이내": c >= hi52 * 0.75,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return { checks, passed, total: 7, ok: passed >= 6,
           ma50: ma50 && Math.round(ma50), ma150: ma150 && Math.round(ma150), ma200: ma200 && Math.round(ma200) };
}

function etSwingHighs(rows, win = ET_SWING_WIN) {
  const out = [];
  const h = rows.map(r => r.high);
  for (let i = win; i < rows.length - win; i++) {
    let isMax = true;
    for (let k = i - win; k <= i + win; k++) if (h[k] > h[i]) { isMax = false; break; }
    if (isMax) out.push([i, h[i]]);
  }
  return out;
}

function etDetectVCP(rows) {
  const base = rows.slice(-ET_BASE_WINDOW);
  const highs = etSwingHighs(base);
  if (!highs.length) return { found: false, reason: "베이스 내 스윙 고점 없음" };

  const contractions = [];
  for (let k = 0; k < highs.length; k++) {
    const [hiIdx, hiVal] = highs[k];
    const endIdx = k + 1 < highs.length ? highs[k + 1][0] : base.length;
    if (endIdx - hiIdx < 2) continue;
    let lowVal = Infinity;
    for (let j = hiIdx; j < endIdx; j++) lowVal = Math.min(lowVal, base[j].low);
    const depth = (hiVal - lowVal) / hiVal * 100;
    if (depth >= 1.0) contractions.push({ high: hiVal, low: lowVal, depth: Math.round(depth * 10) / 10 });
  }
  if (contractions.length < 2)
    return { found: false, reason: `수축 ${contractions.length}회 (최소 2회 필요)` };

  const depths = contractions.map(c => c.depth);
  let tightening = true;
  for (let i = 0; i < depths.length - 1; i++) if (depths[i + 1] > depths[i] * 1.1) { tightening = false; break; }
  const finalOk = depths[depths.length - 1] <= ET_MAX_FINAL_CONTRACTION;

  const vols = rows.map(r => r.volume);
  const vol50 = etSMAat(vols, 50, vols.length - 1);
  const vol5 = etSMAat(vols, 5, vols.length - 1);
  const dryup = vol50 != null && vol5 != null && vol5 < vol50 * ET_VOL_DRYUP_RATIO;

  const found = tightening && finalOk;
  return {
    found, n_contractions: contractions.length, depths,
    tightening, final_contraction_ok: finalOk, volume_dryup: !!dryup,
    pivot: contractions[contractions.length - 1].high,
    reason: found ? null : (!tightening ? "수축폭이 줄어들지 않음"
            : `마지막 수축 ${depths[depths.length - 1]}% > ${ET_MAX_FINAL_CONTRACTION}%`),
  };
}

function etDetectDarvas(rows) {
  const h = rows.map(r => r.high), l = rows.map(r => r.low);
  const n = rows.length;
  let topIdx = null;
  const stop = Math.max(n - ET_BASE_WINDOW, 0);
  for (let i = n - ET_DARVAS_CONFIRM - 1; i > stop; i--) {
    let winMax = -Infinity;
    for (let k = i; k < Math.min(i + ET_DARVAS_CONFIRM + 1, n); k++) winMax = Math.max(winMax, h[k]);
    let prevMax = -Infinity;
    for (let k = Math.max(0, i - 10); k <= i; k++) prevMax = Math.max(prevMax, h[k]);
    if (h[i] === winMax && h[i] >= prevMax) { topIdx = i; break; }
  }
  if (topIdx == null) return { found: false, reason: "확정된 박스 상단 없음" };
  const top = h[topIdx];

  const segL = l.slice(topIdx);
  let bottom = null, confirmedBottom = false;
  for (let j = 1; j <= segL.length - ET_DARVAS_CONFIRM; j++) {
    let cand = Infinity;
    for (let k = j; k < j + ET_DARVAS_CONFIRM; k++) cand = Math.min(cand, segL[k]);
    if (segL[j] === cand) {
      let ok = true;
      for (let k = 1; k < ET_DARVAS_CONFIRM; k++) if (segL[j + k] < cand) { ok = false; break; }
      if (ok) { bottom = cand; confirmedBottom = true; break; }
    }
  }
  if (bottom == null) bottom = Math.min(...segL);

  return { found: true, top, bottom,
           height_pct: Math.round((top - bottom) / top * 1000) / 10,
           bottom_confirmed: confirmedBottom, days_in_box: n - topIdx };
}

function etVerdict(rows) {
  const last = rows[rows.length - 1];
  const close = last.close;
  const tt = etTrendTemplate(rows);
  const vcp = etDetectVCP(rows);
  const box = etDetectDarvas(rows);

  let pivot = null, pattern = null;
  if (vcp.found) { pivot = vcp.pivot; pattern = "VCP"; }
  else if (box.found) { pivot = box.top; pattern = "DARVAS"; }

  const notes = [];
  const vols = rows.map(r => r.volume);
  const vol50 = etSMAat(vols, 50, vols.length - 1);
  const breakoutVol = vol50 != null && last.volume >= vol50 * ET_BREAKOUT_VOL_RATIO;

  if (!tt.ok) notes.push(`트렌드 템플릿 ${tt.passed}/${tt.total} — 추세 조건 미달`);

  if (pattern === "DARVAS" && close < box.bottom) {
    notes.push(`박스 하단(${Math.round(box.bottom).toLocaleString()}) 이탈 — 박스 무효, 재구축 대기`);
    pivot = null; pattern = null;
  }

  let verdict = "NO_SETUP";
  let extPct = null, distPct = null;
  if (pivot != null) {
    extPct = (close - pivot) / pivot * 100;
    distPct = (pivot - close) / close * 100;
    if (close > pivot) {
      if (extPct <= ET_CHASE_PCT && tt.ok) {
        verdict = breakoutVol ? "BUY_POINT" : "BUY_POINT_LOWVOL";
        if (!breakoutVol) notes.push("돌파했으나 거래량 미충족(50일 평균 1.5배 미만) — 신뢰도 낮음");
      } else {
        verdict = "EXTENDED";
        notes.push(`피벗 +${extPct.toFixed(1)}% — 추격 금지, 다음 베이스 대기`);
      }
    } else if (distPct <= ET_NEAR_PIVOT_PCT && tt.ok) {
      verdict = "SETUP";
    } else {
      verdict = "NO_SETUP";
      if (tt.ok) notes.push(`피벗까지 +${distPct.toFixed(1)}% — 베이스 하단, 셋업 미성숙`);
    }
  }

  return {
    date: last.date, close, verdict, pattern,
    pivot: pivot != null ? Math.round(pivot) : null,
    dist_to_pivot_pct: pivot != null ? Math.round(distPct * 10) / 10 : null,
    ext_pct: extPct != null ? Math.round(extPct * 10) / 10 : null,
    breakout_volume_ok: !!breakoutVol,
    atr20: etATR20(rows),
    trend_template: tt, vcp, darvas: box, notes,
  };
}

async function etAnalyze(code) {
  const rows = await ckOHLCV(code, 320);
  if (rows.length < 120) throw new Error(`가격 데이터 부족 (${rows.length}일)`);
  let name = null;
  try {
    const items = await ckSearch(code);
    const hit = items.find(x => x.code === code) || items[0];
    if (hit) name = hit.name;
  } catch (e) { /* 이름 조회 실패 허용 */ }
  return { code, name, ...etVerdict(rows) };
}

async function handleEntry(req, url, ctx) {
  const p = url.pathname.slice("/api/entry/".length);
  try {
    if (p.startsWith("analyze/")) {
      const code = p.slice(8).replace(/[^0-9A-Za-z]/g, "");
      if (!code) return new Response(JSON.stringify({ ok: false, error: "code 필요" }), { status: 400, headers: JSON_HEADERS });
      return await ckCached(req, 180, async () => ({ ok: true, data: await etAnalyze(code) }));
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

  // 6. 이익 구간 과매수 — 부분 익절(TRIM) 신호 (등급 TP, 위험점수 미가산)
  const extPct = ma50 != null ? (price / ma50 - 1) * 100 : 0;
  let nTP = 0;
  if (pnl != null && pnl > 0) {
    if (rsi14 >= 70) {
      const strong = rsi14 >= 80;
      signals.push(["TP", "TP_RSI", `RSI ${Math.round(rsi14)} 과매수${strong ? "(강)" : ""}${nearHigh ? " · 고점권" : ""}`]);
      nTP += strong ? 2 : 1;
    }
    if (extPct >= 20) {
      signals.push(["TP", "TP_EXT", `50일선 대비 +${R1(extPct)}% 과이격 — 평균 회귀 위험`]);
      nTP++;
    }
    if (runup10 >= 20) {
      signals.push(["TP", "TP_RUNUP", `10거래일 +${R1(runup10)}% 단기 급등 — 이익 실현 압력`]);
      nTP++;
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

  const verdict = nCrit >= 1 ? "SELL" : nWarn >= 1 ? "WATCH" : nTP >= 1 ? "TRIM" : "HOLD";
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
    trim_level: nTP,
    signals: signals.map(([grade, code2, msg]) => ({ grade, code: code2, msg })),
  };
}

async function slHoldings(env, offset = 0, limit = SL.AUTO_TOP_N, excludeEtf = true) {
  const q = await env.RISK_DB.prepare(
    "SELECT code,name,qty,buy_amount,eval_amount,weight FROM holdings ORDER BY eval_amount DESC LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();
  let rows = q.results;
  if (excludeEtf) rows = rows.filter(h => !ckIsEtf(String(h.name || "")));
  return rows.map(h => ({
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
  const ORD = { SELL: 0, WATCH: 1, TRIM: 2, HOLD: 3 };
  settled.sort((a, b) => ((ORD[a.verdict] ?? 4) - (ORD[b.verdict] ?? 4)) ||
    ((b.score ?? -1) - (a.score ?? -1)) || ((b.trim_level ?? 0) - (a.trim_level ?? 0)));
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

const SL_VLABEL = { SELL: "즉시 손절 후보", WATCH: "경고(감시)", TRIM: "부분 익절 후보", HOLD: "유지" };

// ── 자동 점검(크론·수동 refresh 공용): 상위 N 스캔 → KV 저장 → 신규 신호 알림 ──
async function slRefresh(env, { notify = false, topN = SL.AUTO_TOP_N, trailPct = SL.TRAIL_PCT, session = "close" } = {}) {
  const market = await slMarket();
  // ETF 제외 후에도 topN개 개별 종목을 확보하도록 여유 있게 조회
  const holdings = (await slHoldings(env, 0, topN * 2 + 30)).slice(0, topN);
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
    scope: { top_n: topN, etf_excluded: true, total: (await env.RISK_DB.prepare("SELECT COUNT(*) n FROM holdings").first()).n },
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
      return new Response(JSON.stringify({ ok: true, data: { total, offset, count: holdings.length, etf_excluded: limit - holdings.length, market, results } }), { headers: JSON_HEADERS });
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
        trim: data.results.filter(r => r.verdict === "TRIM").length,
        escalated,
      }), { headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404, headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: JSON_HEADERS });
  }
}

/* ═══════════════ Trade Journal (/api/journal/*) ═══════════════
   매매 저널: 폰에서 매수/매도 기록·복기·교훈 관리 (D1 trades·lessons 테이블).
   쓰기는 Bearer 토큰(meta.journal_token_hash) 필요, 기록 시 텔레그램 알림. */

const TJ_SITE = "https://trend-insight-site.sungsangkyung77.workers.dev/journal.html";
const tjJson = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
const tjWon = v => (v == null ? "—" : Math.round(v).toLocaleString("ko-KR"));

async function tjAuth(req, env) {
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth) return false;
  const row = await env.RISK_DB.prepare("SELECT value FROM meta WHERE key='journal_token_hash'").first();
  return !!row && (await rkSha256(auth)) === row.value;
}

// R배수 = (청산가 − 진입가) ÷ (진입가 − 손절가)
function tjRMult(entry, stop, exitP) {
  if (!entry || !stop || exitP == null) return null;
  const risk = entry - stop;
  if (risk <= 0) return null;
  return R2((exitP - entry) / risk);
}

async function handleJournal(req, url, env, ctx) {
  const p = url.pathname.slice("/api/journal/".length);
  try {
    if (p === "state" && req.method === "GET") {
      const [rules, meta, open, closed, lessons] = await Promise.all([
        env.RISK_DB.prepare("SELECT key,value,label FROM rules").all(),
        env.RISK_DB.prepare("SELECT key,value FROM meta WHERE key NOT LIKE '%token%'").all(),
        env.RISK_DB.prepare("SELECT * FROM trades WHERE status='OPEN' ORDER BY entry_date DESC, id DESC").all(),
        env.RISK_DB.prepare("SELECT * FROM trades WHERE status='CLOSED' ORDER BY exit_date DESC, id DESC LIMIT 200").all(),
        env.RISK_DB.prepare("SELECT * FROM lessons WHERE active=1 ORDER BY id DESC LIMIT 100").all(),
      ]);
      const r = {}; for (const x of rules.results) r[x.key] = x.value;
      const m = {}; for (const x of meta.results) m[x.key] = x.value;
      return tjJson({ ok: true, data: { rules: r, meta: m, open: open.results, closed: closed.results, lessons: lessons.results } });
    }

    if (req.method !== "POST") return tjJson({ ok: false, error: "unknown endpoint" }, 404);
    if (!(await tjAuth(req, env))) return tjJson({ ok: false, error: "unauthorized" }, 401);
    const body = await req.json();
    const now = kstNow();
    const today = now.slice(0, 10);

    // ── 매수 기록 ──
    if (p === "entry") {
      if (!body.code || !body.entry_price) return tjJson({ ok: false, error: "code/entry_price 필수" }, 400);
      const ep = +body.entry_price;
      const res = await env.RISK_DB.prepare(
        "INSERT INTO trades(code,name,status,entry_date,entry_price,qty,stop_price,target_price,thesis,checklist,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(String(body.code), body.name ?? null, "OPEN", body.entry_date || today, ep,
          body.qty ? +body.qty : null, body.stop_price ? +body.stop_price : null,
          body.target_price ? +body.target_price : null, body.thesis ?? null,
          body.checklist ? JSON.stringify(body.checklist) : null, now, now).run();
      const stop = body.stop_price ? +body.stop_price : null;
      const tgt = body.target_price ? +body.target_price : null;
      const rr = stop && tgt && ep > stop ? R2((tgt - ep) / (ep - stop)) : null;
      const text = [`📘 <b>매수 기록</b> — ${body.name || body.code}(${body.code})`,
        `진입 ${tjWon(ep)}${body.qty ? ` × ${(+body.qty).toLocaleString("ko-KR")}주` : ""}`,
        stop ? `손절 ${tjWon(stop)} (${R1((stop / ep - 1) * 100)}%)${tgt ? ` · 목표 ${tjWon(tgt)}` : ""}${rr ? ` · 손익비 ${rr}` : ""}` : "⚠️ 손절가 미설정 — 규정 위반",
        body.thesis ? `논거: ${body.thesis}` : "⚠️ 논거 미작성",
        TJ_SITE].join("\n");
      ctx.waitUntil(slTelegram(env, text).catch(() => {}));
      return tjJson({ ok: true, id: res.meta.last_row_id });
    }

    // ── 매도(청산) 기록 + 30초 복기 ──
    if (p === "close") {
      const tr = await env.RISK_DB.prepare("SELECT * FROM trades WHERE id=?").bind(+body.id).first();
      if (!tr) return tjJson({ ok: false, error: "해당 매매 없음" }, 404);
      if (!body.exit_price) return tjJson({ ok: false, error: "exit_price 필수" }, 400);
      const exitP = +body.exit_price;
      const pnl = tr.entry_price ? R2((exitP / tr.entry_price - 1) * 100) : null;
      const rMult = tjRMult(tr.entry_price, tr.stop_price, exitP);
      await env.RISK_DB.prepare(
        "UPDATE trades SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?, pnl_pct=?, r_multiple=?, quad=?, proc_rule=?, proc_thesis=?, proc_plan=?, lesson=?, updated_at=? WHERE id=?")
        .bind(body.exit_date || today, exitP, body.exit_reason ?? null, pnl, rMult,
          body.quad ?? null, body.proc_rule ?? null, body.proc_thesis ?? null, body.proc_plan ?? null,
          body.lesson ?? null, now, tr.id).run();
      if (body.lesson)
        await env.RISK_DB.prepare("INSERT INTO lessons(date,text,source,active) VALUES(?,?,?,1)")
          .bind(today, body.lesson, `${tr.name || tr.code}(${tr.code})`).run();
      const QUAD = { GG: "좋은 과정·좋은 결과 — 반복하라", GB: "좋은 과정·나쁜 결과 — 과정 유지", BG: "나쁜 과정·좋은 결과 — ⚠️ 가장 위험", BB: "나쁜 과정·나쁜 결과 — 교정" };
      const icon = pnl != null && pnl >= 0 ? "🔴" : "🔵";
      const text = [`📕 <b>매도 기록</b> — ${tr.name || tr.code}(${tr.code})`,
        `청산 ${tjWon(exitP)} · 손익 ${pnl != null ? (pnl > 0 ? "+" : "") + pnl + "%" : "—"}${rMult != null ? ` (${rMult > 0 ? "+" : ""}${rMult}R)` : ""} ${icon}`,
        body.exit_reason ? `사유: ${body.exit_reason}` : "",
        body.quad && QUAD[body.quad] ? `복기: ${QUAD[body.quad]}` : "복기 미완 — 저널에서 복기하세요",
        body.lesson ? `교훈: ${body.lesson}` : "",
        TJ_SITE].filter(Boolean).join("\n");
      ctx.waitUntil(slTelegram(env, text).catch(() => {}));
      return tjJson({ ok: true, pnl_pct: pnl, r_multiple: rMult });
    }

    // ── 사후 복기 (청산 후 4분면·교훈 보완) / 손절·목표 수정 ──
    if (p === "review") {
      const tr = await env.RISK_DB.prepare("SELECT * FROM trades WHERE id=?").bind(+body.id).first();
      if (!tr) return tjJson({ ok: false, error: "해당 매매 없음" }, 404);
      await env.RISK_DB.prepare(
        "UPDATE trades SET quad=COALESCE(?,quad), proc_rule=COALESCE(?,proc_rule), proc_thesis=COALESCE(?,proc_thesis), proc_plan=COALESCE(?,proc_plan), lesson=COALESCE(?,lesson), stop_price=COALESCE(?,stop_price), target_price=COALESCE(?,target_price), thesis=COALESCE(?,thesis), updated_at=? WHERE id=?")
        .bind(body.quad ?? null, body.proc_rule ?? null, body.proc_thesis ?? null, body.proc_plan ?? null,
          body.lesson ?? null, body.stop_price ? +body.stop_price : null, body.target_price ? +body.target_price : null,
          body.thesis ?? null, now, tr.id).run();
      if (body.lesson)
        await env.RISK_DB.prepare("INSERT INTO lessons(date,text,source,active) VALUES(?,?,?,1)")
          .bind(today, body.lesson, `${tr.name || tr.code}(${tr.code})`).run();
      return tjJson({ ok: true });
    }

    // ── 교훈 추가/비활성 ──
    if (p === "lesson") {
      if (body.deactivate) {
        await env.RISK_DB.prepare("UPDATE lessons SET active=0 WHERE id=?").bind(+body.deactivate).run();
        return tjJson({ ok: true });
      }
      if (!body.text) return tjJson({ ok: false, error: "text 필수" }, 400);
      const res = await env.RISK_DB.prepare("INSERT INTO lessons(date,text,source,active) VALUES(?,?,?,1)")
        .bind(today, body.text, body.source ?? "직접 입력").run();
      return tjJson({ ok: true, id: res.meta.last_row_id });
    }

    // ── 기록 삭제 (오입력 정정) ──
    if (p === "delete") {
      await env.RISK_DB.prepare("DELETE FROM trades WHERE id=?").bind(+body.id).run();
      return tjJson({ ok: true });
    }

    return tjJson({ ok: false, error: "unknown endpoint" }, 404);
  } catch (e) {
    return tjJson({ ok: false, error: String(e) }, 500);
  }
}

/* ═══════════════════════════════════════════════════════════════════ */


/* ═══════════════ Forensic (/api/forensic/*) — DART OpenAPI 프록시 ═══════════════
   회계 품질·지배구조 포렌식 체크리스트 페이지 전용. env.DART_KEY(대시보드 시크릿) 사용.
   corpCode.xml(zip)을 GAUGE_KV에 24h 캐시하여 6자리 종목코드→8자리 corp_code 매핑. */
const DART_BASE = "https://opendart.fss.or.kr/api";
const DART_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "application/json,text/xml,application/zip,*/*" };
// 키 출처: D1 secrets 테이블(dart_api_key) 우선 → env.DART_KEY 폴백.
// D1은 배포/빌드와 무관하게 유지되므로 GitHub 빌드가 대시보드 시크릿을 덮어써도 안전.
async function getDartKey(env) {
  try {
    const r = await env.RISK_DB.prepare("SELECT value FROM secrets WHERE key='dart_api_key'").first();
    if (r && r.value) return r.value;
  } catch (e) { /* D1 조회 실패 시 env 폴백 */ }
  return env.DART_KEY || null;
}
const FJ = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSON_HEADERS });
function fYmd(d) { return "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0"); }
function fNum(v) { const x = parseFloat(String(v == null ? "" : v).replace(/,/g, "")); return isNaN(x) ? null : x; }
function fPick(list, exact, incl) {
  const norm = s => (s || "").replace(/\s/g, "");
  for (const a of list) if (exact.includes(norm(a.account_nm))) { const n = fNum(a.thstrm_amount); if (n != null) return n; }
  if (incl) for (const a of list) { const nm = norm(a.account_nm); if (incl.some(k => nm.includes(k))) { const n = fNum(a.thstrm_amount); if (n != null) return n; } }
  return null;
}
async function dartGet(env, path, params) {
  const key = await getDartKey(env);
  if (!key) return { status: "NOKEY", message: "DART 키 미설정" };
  const qs = new URLSearchParams({ crtfc_key: key, ...params });
  try {
    const r = await fetch(`${DART_BASE}/${path}?${qs}`, { headers: DART_HEADERS, cf: { cacheTtl: 600 } });
    if (!r.ok) return { status: "HTTP" + r.status, message: "DART HTTP 오류" };
    return await r.json();
  } catch (e) { return { status: "ERR", message: String(e) }; }
}
async function dartUnzipFirst(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD → 중앙디렉터리 → 정확한 압축크기(compsize)로 슬라이스한다.
  // (파일 끝까지 넘기면 뒤쪽 데이터디스크립터/중앙디렉터리가 잔여바이트로 붙어
  //  DecompressionStream이 스트림을 error 시키고 이미 방출한 청크까지 폐기됨 → xml_len 0)
  let e = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { e = i; break; }
  }
  if (e < 0) throw new Error("EOCD not found");
  const cd = dv.getUint32(e + 16, true);
  if (!(bytes[cd] === 0x50 && bytes[cd + 1] === 0x4b && bytes[cd + 2] === 0x01 && bytes[cd + 3] === 0x02))
    throw new Error("central dir mismatch");
  const method = dv.getUint16(cd + 10, true);
  const compsize = dv.getUint32(cd + 20, true);
  const localoff = dv.getUint32(cd + 42, true);
  const namelen = dv.getUint16(localoff + 26, true);
  const extralen = dv.getUint16(localoff + 28, true);
  const startPos = localoff + 30 + namelen + extralen;
  const comp = bytes.subarray(startPos, startPos + compsize);   // 정확한 길이
  if (method === 0) return new TextDecoder("utf-8").decode(comp);
  const ds = new DecompressionStream("deflate-raw");
  const out = new Uint8Array(await new Response(new Response(comp).body.pipeThrough(ds)).arrayBuffer());
  return new TextDecoder("utf-8").decode(out);
}
async function dartCorpMap(env) {
  const cached = await env.GAUGE_KV.get("dart-corpmap");
  if (cached) return JSON.parse(cached);
  const key = await getDartKey(env);
  if (!key) return null;
  const r = await fetch(`${DART_BASE}/corpCode.xml?crtfc_key=${key}`, { headers: DART_HEADERS, redirect: "manual" });
  if (r.status !== 200) throw new Error("DART_CORPCODE_HTTP_" + r.status);
  const xml = await dartUnzipFirst(new Uint8Array(await r.arrayBuffer()));
  const map = {};
  // 상장사(6자리 stock_code)만 선형 추출. <list> 순서: corp_code, corp_name, corp_eng_name, stock_code, modify_date
  const re = /<corp_code>(\d+)<\/corp_code>\s*<corp_name>([^<]*)<\/corp_name>\s*<corp_eng_name>[^<]*<\/corp_eng_name>\s*<stock_code>(\d{6})<\/stock_code>/g;
  let m;
  while ((m = re.exec(xml))) map[m[3]] = { corp_code: m[1], corp_name: m[2].trim() };
  await env.GAUGE_KV.put("dart-corpmap", JSON.stringify(map), { expirationTtl: 86400 });
  return map;
}
async function handleForensic(req, url, env) {
  const p = url.pathname.slice("/api/forensic/".length);
  try {
    const dkey = await getDartKey(env);
    if (!dkey) return FJ({ ok: false, error: "DART 키 미설정 — D1(risk-manager) secrets 테이블에 dart_api_key를 넣거나 env.DART_KEY를 설정하세요." });
    const stock = (url.searchParams.get("stock") || "").replace(/[^0-9A-Za-z]/g, "").padStart(6, "0");
    if (p === "resolve") {
      const map = await dartCorpMap(env);
      const hit = map && map[stock];
      return FJ(hit ? { ok: true, ...hit, stock } : { ok: false, error: "corp_code 매핑 없음", stock });
    }
    if (p === "scan") {
      const map = await dartCorpMap(env);
      const hit = map && map[stock];
      if (!hit) return FJ({ ok: false, error: "corp_code 매핑 없음 (신규상장·비상장 가능)", stock });
      const cc = hit.corp_code;
      const years = Math.min(parseInt(url.searchParams.get("years") || "5", 10) || 5, 10);
      const now = new Date();
      const end = fYmd(now);
      const bgn = fYmd(new Date(now.getFullYear() - years, now.getMonth(), now.getDate()));
      const [cb, bw, eb, rights, disc, st] = await Promise.all([
        dartGet(env, "cvbdIsDecsn.json", { corp_code: cc, bgn_de: bgn, end_de: end }),
        dartGet(env, "bdwtIsDecsn.json", { corp_code: cc, bgn_de: bgn, end_de: end }),
        dartGet(env, "exbdIsDecsn.json", { corp_code: cc, bgn_de: bgn, end_de: end }),
        dartGet(env, "piicDecsn.json", { corp_code: cc, bgn_de: bgn, end_de: end }),
        dartGet(env, "list.json", { corp_code: cc, bgn_de: bgn, end_de: end, page_count: "100", last_reprt_at: "N" }),
        dartGet(env, "stockTotqySttus.json", { corp_code: cc, bsns_year: String(now.getFullYear() - 1), reprt_code: "11011" }),
      ]);
      const yrs = [now.getFullYear() - 3, now.getFullYear() - 2, now.getFullYear() - 1];
      const fin = [];
      for (const y of yrs) {
        let f = await dartGet(env, "fnlttSinglAcntAll.json", { corp_code: cc, bsns_year: String(y), reprt_code: "11011", fs_div: "CFS" });
        if (f.status !== "000") f = await dartGet(env, "fnlttSinglAcntAll.json", { corp_code: cc, bsns_year: String(y), reprt_code: "11011", fs_div: "OFS" });
        if (f.status === "000" && Array.isArray(f.list)) {
          fin.push({
            year: y,
            revenue: fPick(f.list, ["매출액", "수익(매출액)", "영업수익", "매출"], ["매출액"]),
            receivables: fPick(f.list, ["매출채권", "매출채권및기타채권", "매출채권및기타유동채권", "매출채권및기타유동자산"], ["매출채권"]),
            inventory: fPick(f.list, ["재고자산"], ["재고자산"]),
            cogs: fPick(f.list, ["매출원가"], ["매출원가"]),
          });
        }
      }
      let shares = null;
      if (st.status === "000" && Array.isArray(st.list)) {
        const row = st.list.find(r => /보통주/.test(r.se || "")) || st.list.find(r => /합\s*계|계$/.test(r.se || "")) || st.list[0];
        const v = parseInt(String((row && row.istc_totqy) || "").replace(/[^\d]/g, ""), 10);
        if (!isNaN(v)) shares = v;
      }
      const arr = x => (x && x.status === "000" && Array.isArray(x.list)) ? x.list : [];
      return FJ({
        ok: true, stock, corp_code: cc, corp_name: hit.corp_name, period: { bgn, end },
        cb: arr(cb), bw: arr(bw), eb: arr(eb), rights: arr(rights),
        disclosures: arr(disc).map(d => ({ report_nm: d.report_nm, rcept_dt: d.rcept_dt, rcept_no: d.rcept_no, flr_nm: d.flr_nm })),
        shares, fin,
        status: { cb: cb.status, bw: bw.status, eb: eb.status, rights: rights.status, disc: disc.status, st: st.status },
      });
    }
    if (p === "rebuild") {
      await env.GAUGE_KV.delete("dart-corpmap");
      const map = await dartCorpMap(env);
      const n = map ? Object.keys(map).length : 0;
      const keys = map ? Object.keys(map) : [];
      return FJ({ ok: true, listed: n, has005930: !!(map && map["005930"]), samsung: (map && map["005930"]) || null, samples: keys.slice(0, 5) });
    }
    if (p === "keystatus") {
      let d1 = false; try { const r = await env.RISK_DB.prepare("SELECT value FROM secrets WHERE key='dart_api_key'").first(); d1 = !!(r && r.value); } catch (e) {}
      let probe = null;
      try {
        const k = await getDartKey(env);
        if (k) {
          const pr = await fetch(`${DART_BASE}/list.json?crtfc_key=${k}&page_count=1`, { headers: DART_HEADERS, redirect: "manual" });
          const txt = await pr.text();
          let st = null; try { st = JSON.parse(txt).status; } catch (e) { st = "NONJSON"; }
          probe = { http: pr.status, status: st };
        }
      } catch (e) { probe = { status: "ERR", detail: String((e && e.message) || e).slice(0, 80) }; }
      let corp = null;
      try {
        const k = await getDartKey(env);
        if (k) {
          const cr = await fetch(`${DART_BASE}/corpCode.xml?crtfc_key=${k}`, { headers: DART_HEADERS, redirect: "manual" });
          const ab = await cr.arrayBuffer();
          const b = new Uint8Array(ab);
          const head4 = Array.from(b.slice(0, 4)).map(x => x.toString(16).padStart(2, "0")).join("");
          if (head4 !== "504b0304") {
            corp = { http: cr.status, len: b.length, head4, snippet: new TextDecoder("utf-8").decode(b.slice(0, 160)) };
          } else {
            try {
              const xml = await dartUnzipFirst(b);
              corp = { http: cr.status, len: b.length, xml_len: xml.length, xml_head: xml.slice(0, 60), lists: xml.split("<list>").length };
            } catch (ue) {
              corp = { http: cr.status, len: b.length, unzip_err: String((ue && ue.message) || ue).slice(0, 160) };
            }
          }
        }
      } catch (e) { corp = { err: String((e && e.message) || e).slice(0, 120) }; }
      return FJ({ ok: true, d1_key: d1, env_key: !!env.DART_KEY, dart_probe: probe, corp_probe: corp });
    }
    return FJ({ ok: false, error: "unknown endpoint" }, 404);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg.includes("DART_KEY_INVALID"))
      return FJ({ ok: false, error: "DART 키가 유효하지 않습니다(등록되지 않은/미활성 인증키, status 010)." }, 502);
    if (msg.includes("DART_CORPCODE_HTTP_"))
      return FJ({ ok: false, error: "DART corpCode 응답 이상(" + msg + ") — 키/네트워크 확인 필요." }, 502);
    return FJ({ ok: false, error: "DART 조회 오류 (요청/응답 확인 필요)" }, 502);
  }
}


/* ═══════════════ Masters DART (/api/masters/dart/{code}) ═══════════════
   거장 자문단(masters.html) 전용 DART 정량 입력.
   forensic 쪽 헬퍼(getDartKey·dartGet·dartCorpMap·fPick)를 그대로 재사용한다.
   수집: ① 주요재무지표 최신연도 3분류(수익성·안정성·성장성)
        ② 전체재무제표 3개년(매출·영업이익·순이익·영업활동현금흐름·자본총계)
        ③ CB/BW/유상증자 발행 이력(최근 5년) — 멍거 인버전·희석 리스크용
   결과는 GAUGE_KV에 12시간 캐시(md:{code}). */

// 주요 재무지표 코드 → 우리가 쓰는 이름
const MD_IDX = {
  M211550: "roe",           // ROE
  M211200: "netMargin",     // 순이익률
  M211300: "grossMargin",   // 매출총이익률
  M221100: "debtRatio",     // 부채비율
  M221200: "currentRatio",  // 유동비율
  M221600: "interestCover", // 이자보상배율
  M223000: "reserveRatio",  // 자본유보율
  M231000: "revGrowth",     // 매출액증가율 YoY
  M231400: "opGrowth",      // 영업이익증가율 YoY
  M231800: "niGrowth",      // 순이익증가율 YoY
};

// sj_div(재무제표 구분)까지 맞춰 계정 금액을 뽑는다. fPick은 구분을 안 봐서
// 당기순이익처럼 IS/CIS/CF에 중복 등장하는 계정이 엉킬 수 있다.
function mdPick(list, sjDivs, exact, incl) {
  const norm = s => (s || "").replace(/\s/g, "");
  const rows = list.filter(a => sjDivs.includes(a.sj_div));
  for (const a of rows) if (exact.includes(norm(a.account_nm))) { const n = fNum(a.thstrm_amount); if (n != null) return n; }
  if (incl) for (const a of rows) { const nm = norm(a.account_nm); if (incl.some(k => nm.includes(k))) { const n = fNum(a.thstrm_amount); if (n != null) return n; } }
  return null;
}

async function mdIndicators(env, cc, year) {
  const cls = ["M210000", "M220000", "M230000"];
  const rs = await Promise.all(cls.map(c =>
    dartGet(env, "fnlttSinglIndx.json", { corp_code: cc, bsns_year: String(year), reprt_code: "11011", idx_cl_code: c })));
  const out = {};
  for (const r of rs) {
    if (r.status !== "000" || !Array.isArray(r.list)) continue;
    for (const row of r.list) {
      const key = MD_IDX[row.idx_code];
      if (!key) continue;
      const v = fNum(row.idx_val);
      if (v != null) out[key] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

async function mdFinancials(env, cc, year) {
  let f = await dartGet(env, "fnlttSinglAcntAll.json", { corp_code: cc, bsns_year: String(year), reprt_code: "11011", fs_div: "CFS" });
  let div = "CFS";
  if (f.status !== "000") {
    f = await dartGet(env, "fnlttSinglAcntAll.json", { corp_code: cc, bsns_year: String(year), reprt_code: "11011", fs_div: "OFS" });
    div = "OFS";
  }
  if (f.status !== "000" || !Array.isArray(f.list)) return null;
  const L = f.list;
  return {
    year, fs_div: div,
    revenue: mdPick(L, ["IS", "CIS"], ["매출액", "수익(매출액)", "영업수익", "매출"], ["매출액"]),
    opIncome: mdPick(L, ["IS", "CIS"], ["영업이익", "영업이익(손실)", "영업손실"], ["영업이익"]),
    netIncome: mdPick(L, ["IS", "CIS"], ["당기순이익", "당기순이익(손실)", "당기순손실"], ["당기순이익"]),
    ocf: mdPick(L, ["CF"], ["영업활동현금흐름", "영업활동으로인한현금흐름", "영업활동순현금흐름"], ["영업활동"]),
    equity: mdPick(L, ["BS"], ["자본총계"], ["자본총계"]),
    assets: mdPick(L, ["BS"], ["자산총계"], ["자산총계"]),
  };
}

async function handleMastersDart(req, url, env) {
  const code = url.pathname.slice("/api/masters/dart/".length).replace(/[^0-9A-Za-z]/g, "").padStart(6, "0");
  const ck = "md:" + code;
  try {
    const cached = await env.GAUGE_KV.get(ck);
    if (cached && url.searchParams.get("fresh") !== "1") return FJ(JSON.parse(cached));

    const dkey = await getDartKey(env);
    if (!dkey) return FJ({ ok: false, error: "DART 키 미설정" });
    const map = await dartCorpMap(env);
    const hit = map && map[code];
    if (!hit) return FJ({ ok: false, error: "corp_code 매핑 없음 (신규상장·비상장 가능)", stock: code });
    const cc = hit.corp_code;

    // 사업보고서 기준연도: 올해 것은 아직 안 나왔으므로 작년부터 역순 3개년
    const now = new Date();
    const base = now.getFullYear() - 1;
    const years = [base - 2, base - 1, base];

    const bgn = fYmd(new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()));
    const end = fYmd(now);

    const [idx, f0, f1, f2, cb, bw, rights] = await Promise.all([
      mdIndicators(env, cc, base),
      mdFinancials(env, cc, years[0]),
      mdFinancials(env, cc, years[1]),
      mdFinancials(env, cc, years[2]),
      dartGet(env, "cvbdIsDecsn.json", { corp_code: cc, bgn_de: bgn, end_de: end }),
      dartGet(env, "bdwtIsDecsn.json", { corp_code: cc, bgn_de: bgn, end_de: end }),
      dartGet(env, "piicDecsn.json", { corp_code: cc, bgn_de: bgn, end_de: end }),
    ]);

    const fin = [f0, f1, f2].filter(Boolean);
    const latest = fin.length ? fin[fin.length - 1] : null;
    const cnt = x => (x && x.status === "000" && Array.isArray(x.list)) ? x.list.length : 0;

    // 파생 판정값
    const niAll = fin.map(f => f.netIncome).filter(v => v != null);
    const profit3y = niAll.length >= 3 ? niAll.every(v => v > 0) : null;   // 3년 연속 흑자
    const lossYears = niAll.filter(v => v <= 0).length;
    const opAll = fin.map(f => f.opIncome).filter(v => v != null);
    const opProfit3y = opAll.length >= 3 ? opAll.every(v => v > 0) : null;
    // 이익의 질: 영업활동현금흐름이 양(+)이면서 순이익보다 클 것 (버핏)
    // 적자기업은 OCF(-43억) > 순손실(-405억)이어도 "질이 좋다"고 볼 수 없으므로 양수 조건 필수.
    const earnQuality = (latest && latest.ocf != null && latest.netIncome != null)
      ? (latest.ocf > 0 && latest.ocf > latest.netIncome) : null;
    const ocfPositive = latest && latest.ocf != null ? latest.ocf > 0 : null;
    // 3년 매출 CAGR
    let revCagr = null;
    if (fin.length >= 3 && fin[0].revenue > 0 && fin[fin.length - 1].revenue > 0) {
      revCagr = Math.round((Math.pow(fin[fin.length - 1].revenue / fin[0].revenue, 1 / (fin.length - 1)) - 1) * 1000) / 10;
    }
    const dilution = cnt(cb) + cnt(bw) + cnt(rights);

    const body = {
      ok: true, stock: code, corp_code: cc, corp_name: hit.corp_name,
      base_year: base, years: fin.map(f => f.year), fs_div: latest ? latest.fs_div : null,
      idx: idx || null,
      revenue: latest ? latest.revenue : null,
      netIncome: latest ? latest.netIncome : null,
      opIncome: latest ? latest.opIncome : null,
      ocf: latest ? latest.ocf : null,
      equity: latest ? latest.equity : null,
      fin,
      profit3y, opProfit3y, lossYears, earnQuality, ocfPositive, revCagr,
      dilution: { cb: cnt(cb), bw: cnt(bw), rights: cnt(rights), total: dilution },
      updated: new Date().toISOString(),
    };
    await env.GAUGE_KV.put(ck, JSON.stringify(body), { expirationTtl: 43200 }); // 12h
    return FJ(body);
  } catch (e) {
    return FJ({ ok: false, error: "DART 조회 오류: " + String((e && e.message) || e).slice(0, 120), stock: code }, 502);
  }
}


/* ═══════════════════ 나의 하루 투두 (/api/todo/*) ═══════════════════
   todo.html용 백엔드.
   - GET/POST /api/todo/state?k=KEY  : 할 일·루틴·설정을 KV에 저장 (PC↔폰 동기화)
   - GET      /api/todo/ics?k=KEY    : 아이폰 캘린더 구독용 ICS 피드 (앱 → 달력)
   - GET      /api/todo/gcal?k=KEY   : 구글 캘린더 비공개 iCal 주소를 읽어 일정 반환 (달력 → 앱)
   KEY는 개인 비밀키. 없거나 형식이 틀리면 거부한다. */

const TD_BANDS = { am: 9, pm: 14, eve: 19 };
const TD_AREA_LABEL = { work: "회사", home: "가정", self: "개인" };

function tdKey(url) {
  const k = (url.searchParams.get("k") || "").replace(/[^0-9A-Za-z_-]/g, "");
  return k.length >= 8 && k.length <= 64 ? k : null;
}

async function tdLoad(env, k) {
  const raw = await env.GAUGE_KV.get("todo:state:" + k);
  if (!raw) return { tasks: [], routines: [], settings: {}, lastOpen: null };
  try { return JSON.parse(raw); } catch (e) { return { tasks: [], routines: [], settings: {}, lastOpen: null }; }
}

function tdPad(n) { return String(n).padStart(2, "0"); }

// KST 날짜(YYYY-MM-DD) + 시(0~23) → ICS UTC 문자열
function tdUtcStamp(dateStr, hour, min) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d, hour - 9, min || 0, 0);
  const t = new Date(ms);
  return t.getUTCFullYear() + tdPad(t.getUTCMonth() + 1) + tdPad(t.getUTCDate()) + "T"
    + tdPad(t.getUTCHours()) + tdPad(t.getUTCMinutes()) + "00Z";
}

function tdEsc(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function tdFold(line) {
  if (line.length <= 73) return line;
  const out = [];
  let s = line;
  out.push(s.slice(0, 73));
  s = s.slice(73);
  while (s.length > 72) { out.push(" " + s.slice(0, 72)); s = s.slice(72); }
  if (s) out.push(" " + s);
  return out.join("\r\n");
}

// 루틴을 지정 날짜 범위로 전개 (ICS 피드에서 반복 일정도 보이도록)
function tdRoutineDates(r, fromStr, toStr) {
  const out = [];
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td2] = toStr.split("-").map(Number);
  let cur = Date.UTC(fy, fm - 1, fd), end = Date.UTC(ty, tm - 1, td2);
  while (cur <= end) {
    const dt = new Date(cur), w = dt.getUTCDay();
    let hit = false;
    if (r.days === "all") hit = true;
    else if (r.days === "weekday") hit = w >= 1 && w <= 5;
    else if (r.days === "weekend") hit = w === 0 || w === 6;
    else if (/^w[0-6]$/.test(r.days)) hit = w === Number(r.days[1]);
    if (hit) out.push(dt.getUTCFullYear() + "-" + tdPad(dt.getUTCMonth() + 1) + "-" + tdPad(dt.getUTCDate()));
    cur += 86400000;
  }
  return out;
}

function tdBuildIcs(state) {
  const now = new Date();
  const stamp = now.getUTCFullYear() + tdPad(now.getUTCMonth() + 1) + tdPad(now.getUTCDate()) + "T"
    + tdPad(now.getUTCHours()) + tdPad(now.getUTCMinutes()) + tdPad(now.getUTCSeconds()) + "Z";
  const kstNow = new Date(Date.now() + 9 * 3600e3);
  const y = kstNow.getUTCFullYear(), m = kstNow.getUTCMonth(), d = kstNow.getUTCDate();
  const from = new Date(Date.UTC(y, m, d - 30));
  const to = new Date(Date.UTC(y, m, d + 120));
  const fromStr = from.toISOString().slice(0, 10), toStr = to.toISOString().slice(0, 10);

  const rows = [];
  for (const t of (state.tasks || [])) {
    if (!t.date || t.date < fromStr || t.date > toStr) continue;
    if (t.routineId) continue;
    rows.push({ id: t.id, date: t.date, band: t.band, area: t.area, text: t.text, done: t.done, time: t.time });
  }
  for (const r of (state.routines || [])) {
    for (const ds of tdRoutineDates(r, fromStr, toStr)) {
      rows.push({ id: r.id + "-" + ds.replace(/-/g, ""), date: ds, band: r.band, area: r.area, text: r.text, done: false });
    }
  }

  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Trend Insight//My Day Todo//KO",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:나의 하루", "X-WR-TIMEZONE:Asia/Seoul",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  for (const r of rows) {
    let h = TD_BANDS[r.band] !== undefined ? TD_BANDS[r.band] : 9, mi = 0;
    const tm = /^(\d{1,2}):(\d{2})$/.exec(r.time || "");
    if (tm) { h = +tm[1]; mi = +tm[2]; }
    const summary = (r.done ? "✓ " : "") + "[" + (TD_AREA_LABEL[r.area] || "개인") + "] " + r.text;
    L.push("BEGIN:VEVENT");
    L.push("UID:todo-" + r.id + "@trend-insight");
    L.push("DTSTAMP:" + stamp);
    L.push("DTSTART:" + tdUtcStamp(r.date, h, mi));
    L.push("DTEND:" + tdUtcStamp(r.date, h, mi + 30));
    L.push(tdFold("SUMMARY:" + tdEsc(summary)));
    L.push("CATEGORIES:" + (TD_AREA_LABEL[r.area] || "개인"));
    L.push("TRANSP:TRANSPARENT");
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.join("\r\n") + "\r\n";
}

/* ── 구글 캘린더 비공개 iCal 읽기 ── */

function tdUnfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function tdParseDt(val, params) {
  // 반환: {ymd:"YYYY-MM-DD", min: 분(자정부터, KST) | null(종일)}
  const isDate = /VALUE=DATE(?!-TIME)/.test(params || "");
  const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  if (isDate || !m[4]) return { ymd: m[1] + "-" + m[2] + "-" + m[3], min: null };
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const tzm = (params || "").match(/TZID=([^;:]+)/);
  if (m[7]) {
    // UTC → KST
    ms += 9 * 3600e3;
  } else if (tzm && !/Seoul|Asia\/Seoul/i.test(tzm[1])) {
    // 다른 타임존은 정확 변환 불가 — UTC로 간주 후 KST 보정
    ms += 9 * 3600e3;
  }
  const d = new Date(ms);
  return {
    ymd: d.getUTCFullYear() + "-" + tdPad(d.getUTCMonth() + 1) + "-" + tdPad(d.getUTCDate()),
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function tdShift(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.getUTCFullYear() + "-" + tdPad(t.getUTCMonth() + 1) + "-" + tdPad(t.getUTCDate());
}
function tdDow(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function tdAddMonths(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return t.getUTCFullYear() + "-" + tdPad(t.getUTCMonth() + 1) + "-" + tdPad(Math.min(d, last));
}

const TD_DAYNUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// RRULE 전개 (FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY, COUNT, UNTIL 지원)
function tdExpand(startYmd, rrule, fromStr, toStr, exdates) {
  const p = {};
  for (const kv of rrule.split(";")) {
    const i = kv.indexOf("=");
    if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
  }
  const freq = (p.FREQ || "").toUpperCase();
  const step = Math.max(1, parseInt(p.INTERVAL || "1", 10) || 1);
  const count = p.COUNT ? parseInt(p.COUNT, 10) : null;
  let until = null;
  if (p.UNTIL) { const u = tdParseDt(p.UNTIL.replace(/[^0-9TZ]/g, ""), ""); if (u) until = u.ymd; }
  const byday = p.BYDAY ? p.BYDAY.split(",").map(s => TD_DAYNUM[s.replace(/[-+0-9]/g, "").toUpperCase()]).filter(v => v !== undefined) : null;
  const ex = new Set(exdates || []);
  const out = [];
  let cur = startYmd, n = 0, guard = 0;
  const hardEnd = until && until < toStr ? until : toStr;

  if (freq === "WEEKLY" && byday && byday.length) {
    let weekStart = tdShift(startYmd, -tdDow(startYmd));
    while (weekStart <= hardEnd && guard++ < 800) {
      for (const dw of byday.slice().sort((a, b) => a - b)) {
        const ymd = tdShift(weekStart, dw);
        if (ymd < startYmd) continue;
        if (ymd > hardEnd) continue;
        n++;
        if (count && n > count) return out;
        if (ymd >= fromStr && !ex.has(ymd)) out.push(ymd);
      }
      weekStart = tdShift(weekStart, 7 * step);
    }
    return out;
  }

  while (cur <= hardEnd && guard++ < 1200) {
    n++;
    if (count && n > count) break;
    if (cur >= fromStr && !ex.has(cur)) out.push(cur);
    if (freq === "DAILY") cur = tdShift(cur, step);
    else if (freq === "WEEKLY") cur = tdShift(cur, 7 * step);
    else if (freq === "MONTHLY") cur = tdAddMonths(cur, step);
    else if (freq === "YEARLY") cur = tdAddMonths(cur, 12 * step);
    else break;
  }
  return out;
}

function tdParseIcs(text, fromStr, toStr, source) {
  const lines = tdUnfold(text);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { ex: [] }; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.start) {
        const dates = cur.rrule
          ? tdExpand(cur.start.ymd, cur.rrule, fromStr, toStr, cur.ex)
          : (cur.start.ymd >= fromStr && cur.start.ymd <= toStr ? [cur.start.ymd] : []);
        for (const ymd of dates) {
          events.push({
            date: ymd, min: cur.start.min, allDay: cur.start.min === null,
            title: cur.summary || "(제목 없음)", loc: cur.loc || "", source,
            uid: (cur.uid || Math.random().toString(36).slice(2)) + "-" + ymd,
          });
        }
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const head = line.slice(0, ci), val = line.slice(ci + 1);
    const name = head.split(";")[0].toUpperCase();
    const params = head.slice(name.length);
    if (name === "DTSTART") cur.start = tdParseDt(val, params);
    else if (name === "SUMMARY") cur.summary = val.replace(/\\n/g, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
    else if (name === "LOCATION") cur.loc = val.replace(/\\,/g, ",");
    else if (name === "UID") cur.uid = val;
    else if (name === "RRULE") cur.rrule = val;
    else if (name === "EXDATE") { for (const v of val.split(",")) { const e = tdParseDt(v, params); if (e) cur.ex.push(e.ymd); } }
    else if (name === "STATUS" && val === "CANCELLED") cur.start = null;
  }
  return events;
}

/* ── 구글 캘린더 쓰기 (OAuth, 서버 보관 리프레시 토큰) ── */

async function tdGCfg(env, k) {
  const raw = await env.GAUGE_KV.get("todo:gcfg:" + k);
  return raw ? JSON.parse(raw) : {};
}
async function tdGCfgPut(env, k, cfg) {
  await env.GAUGE_KV.put("todo:gcfg:" + k, JSON.stringify(cfg));
}

async function tdGToken(env, k) {
  const cfg = await tdGCfg(env, k);
  if (!cfg.client_id || !cfg.client_secret) throw new Error("구글 클라이언트 정보가 없습니다");
  if (!cfg.refresh_token) throw new Error("구글 연결이 필요합니다");
  const body = new URLSearchParams({
    client_id: cfg.client_id, client_secret: cfg.client_secret,
    refresh_token: cfg.refresh_token, grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("토큰 갱신 실패: " + (j.error_description || j.error || r.status));
  return { token: j.access_token, cfg };
}

function tdEventBody(t) {
  const tm = /^(\d{1,2}):(\d{2})$/.exec(t.time || "");
  const summary = "[" + (TD_AREA_LABEL[t.area] || "개인") + "] " + t.text;
  if (tm) {
    const sh = tdPad(+tm[1]), sm = tdPad(+tm[2]);
    const endMin = (+tm[1]) * 60 + (+tm[2]) + 60;
    const eh = tdPad(Math.floor(endMin / 60) % 24), em = tdPad(endMin % 60);
    return {
      summary,
      start: { dateTime: t.date + "T" + sh + ":" + sm + ":00", timeZone: "Asia/Seoul" },
      end: { dateTime: t.date + "T" + eh + ":" + em + ":00", timeZone: "Asia/Seoul" },
      description: "나의 하루 앱에서 등록",
    };
  }
  const [y, m, d] = t.date.split("-").map(Number);
  const nx = new Date(Date.UTC(y, m - 1, d + 1));
  const nxs = nx.getUTCFullYear() + "-" + tdPad(nx.getUTCMonth() + 1) + "-" + tdPad(nx.getUTCDate());
  return { summary, start: { date: t.date }, end: { date: nxs }, description: "나의 하루 앱에서 등록" };
}

async function tdGCall(token, calId, method, path, body) {
  const url = "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) + "/events" + (path || "");
  const r = await fetch(url, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === "DELETE") return { ok: r.ok || r.status === 410 || r.status === 404 };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
  return j;
}

async function tdGSync(req, url, env, k) {
  const payload = await req.json();
  const ops = Array.isArray(payload.ops) ? payload.ops.slice(0, 60) : [];
  const { token, cfg } = await tdGToken(env, k);
  const calId = cfg.calendar_id || "primary";
  const results = [];
  for (const o of ops) {
    try {
      if (o.op === "delete") {
        if (o.gid) await tdGCall(token, calId, "DELETE", "/" + encodeURIComponent(o.gid));
        results.push({ id: o.id, gid: null, ok: true });
      } else if (o.gid) {
        const j = await tdGCall(token, calId, "PATCH", "/" + encodeURIComponent(o.gid), tdEventBody(o.task));
        results.push({ id: o.id, gid: j.id || o.gid, ok: true });
      } else {
        const j = await tdGCall(token, calId, "POST", "", tdEventBody(o.task));
        results.push({ id: o.id, gid: j.id, ok: true });
      }
    } catch (e) {
      const msg = String(e.message || e);
      if (/404|410|Not Found/i.test(msg) && o.op !== "delete") {
        try {
          const j = await tdGCall(token, calId, "POST", "", tdEventBody(o.task));
          results.push({ id: o.id, gid: j.id, ok: true });
          continue;
        } catch (e2) { results.push({ id: o.id, ok: false, error: String(e2.message || e2) }); continue; }
      }
      results.push({ id: o.id, ok: false, error: msg });
    }
  }
  return new Response(JSON.stringify({ ok: true, results, calendarId: calId }), { headers: JSON_HEADERS });
}

function tdOAuthStart(url, k, cfg) {
  const redirect = url.origin + "/api/todo/oauth/callback";
  const p = new URLSearchParams({
    client_id: cfg.client_id, redirect_uri: redirect, response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: k,
  });
  return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + p.toString(), 302);
}

function tdHtml(title, msg, ok) {
  return new Response("<!DOCTYPE html><html lang=ko><head><meta charset=UTF-8>"
    + "<meta name=viewport content='width=device-width,initial-scale=1'><title>" + title + "</title>"
    + "<style>body{font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;background:#f6f5f1;color:#22211e;"
    + "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}"
    + ".c{background:#fff;border-radius:14px;padding:28px;max-width:420px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.1)}"
    + "h1{font-size:19px;margin:0 0 10px;color:" + (ok ? "#0F6E56" : "#A32D2D") + "}"
    + "p{font-size:14px;line-height:1.7;color:#5f5e5a;margin:0 0 18px}"
    + "a{display:inline-block;background:#22211e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-size:14px}</style>"
    + "</head><body><div class=c><h1>" + title + "</h1><p>" + msg + "</p><a href='/todo'>앱으로 돌아가기</a></div></body></html>",
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function tdOAuthCallback(url, env) {
  const k = (url.searchParams.get("state") || "").replace(/[^0-9A-Za-z_-]/g, "");
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) return tdHtml("연결 취소됨", "구글 연결이 취소되었습니다. (" + err + ")", false);
  if (!k || !code) return tdHtml("연결 실패", "필요한 정보가 없습니다.", false);
  const cfg = await tdGCfg(env, k);
  if (!cfg.client_id || !cfg.client_secret) return tdHtml("연결 실패", "클라이언트 정보를 먼저 저장하세요.", false);
  const body = new URLSearchParams({
    code, client_id: cfg.client_id, client_secret: cfg.client_secret,
    redirect_uri: url.origin + "/api/todo/oauth/callback", grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const j = await r.json();
  if (!j.refresh_token) {
    return tdHtml("연결 실패", "리프레시 토큰을 받지 못했습니다: " + (j.error_description || j.error || "알 수 없음")
      + "<br>구글 계정 → 보안 → 서드파티 앱에서 기존 권한을 삭제한 뒤 다시 시도하세요.", false);
  }
  cfg.refresh_token = j.refresh_token;
  cfg.connected_at = Date.now();
  await tdGCfgPut(env, k, cfg);
  return tdHtml("구글 캘린더 연결 완료", "이제 앱에서 만든 일정이 구글 캘린더에 자동으로 등록됩니다.", true);
}

async function tdHandle(req, url, env, ctx) {
  if (url.pathname === "/api/todo/oauth/callback") {
    try { return await tdOAuthCallback(url, env); }
    catch (e) { return tdHtml("연결 실패", String(e.message || e), false); }
  }
  const k = tdKey(url);
  if (!k) return new Response(JSON.stringify({ ok: false, error: "키가 필요합니다" }), { status: 401, headers: JSON_HEADERS });
  const p = url.pathname.slice("/api/todo/".length);

  try {
    if (p === "state") {
      if (req.method === "POST") {
        const body = await req.text();
        if (body.length > 900000) throw new Error("데이터가 너무 큽니다");
        JSON.parse(body);
        await env.GAUGE_KV.put("todo:state:" + k, body);
        return new Response(JSON.stringify({ ok: true, savedAt: Date.now() }), { headers: JSON_HEADERS });
      }
      const st = await tdLoad(env, k);
      return new Response(JSON.stringify({ ok: true, state: st }), { headers: JSON_HEADERS });
    }

    if (p === "gcfg") {
      if (req.method === "POST") {
        const b = await req.json();
        const cfg = await tdGCfg(env, k);
        if (b.client_id !== undefined) cfg.client_id = String(b.client_id || "").trim();
        if (b.client_secret !== undefined && b.client_secret !== "") cfg.client_secret = String(b.client_secret).trim();
        if (b.calendar_id !== undefined) cfg.calendar_id = String(b.calendar_id || "primary").trim();
        if (b.disconnect) { delete cfg.refresh_token; delete cfg.connected_at; }
        await tdGCfgPut(env, k, cfg);
        return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
      }
      const cfg = await tdGCfg(env, k);
      return new Response(JSON.stringify({
        ok: true, hasClient: !!(cfg.client_id && cfg.client_secret),
        connected: !!cfg.refresh_token, clientId: cfg.client_id || "",
        calendarId: cfg.calendar_id || "primary",
        redirectUri: url.origin + "/api/todo/oauth/callback",
      }), { headers: JSON_HEADERS });
    }

    if (p === "oauth/start") {
      const cfg = await tdGCfg(env, k);
      if (!cfg.client_id) return tdHtml("설정 필요", "앱 설정에서 클라이언트 ID와 시크릿을 먼저 저장하세요.", false);
      return tdOAuthStart(url, k, cfg);
    }

    if (p === "gsync" && req.method === "POST") return await tdGSync(req, url, env, k);

    if (p === "gcals") {
      const { token } = await tdGToken(env, k);
      const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { authorization: "Bearer " + token },
      });
      const j = await r.json();
      const list = (j.items || []).filter(c => c.accessRole === "owner" || c.accessRole === "writer")
        .map(c => ({ id: c.id, summary: c.summary }));
      return new Response(JSON.stringify({ ok: true, calendars: list }), { headers: JSON_HEADERS });
    }

    if (p === "ics") {
      const st = await tdLoad(env, k);
      return new Response(tdBuildIcs(st), {
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "cache-control": "public, max-age=300",
          "content-disposition": 'inline; filename="my-day.ics"',
        },
      });
    }

    if (p === "gcal") {
      const st = await tdLoad(env, k);
      const urls = ((st.settings && st.settings.icalUrls) || []).filter(u => /^https:\/\//.test(u)).slice(0, 5);
      if (!urls.length) return new Response(JSON.stringify({ ok: true, events: [], note: "등록된 캘린더 주소가 없습니다" }), { headers: JSON_HEADERS });

      const kst = new Date(Date.now() + 9 * 3600e3);
      const y = kst.getUTCFullYear(), m = kst.getUTCMonth(), d = kst.getUTCDate();
      const fromStr = new Date(Date.UTC(y, m, d - 14)).toISOString().slice(0, 10);
      const toStr = new Date(Date.UTC(y, m, d + 90)).toISOString().slice(0, 10);

      const cacheKey = "todo:gcal:" + k;
      if (url.searchParams.get("refresh") !== "1") {
        const hit = await env.GAUGE_KV.get(cacheKey);
        if (hit) {
          const j = JSON.parse(hit);
          if (Date.now() - (j.at || 0) < 600000 && j.from === fromStr) return new Response(hit, { headers: JSON_HEADERS });
        }
      }

      const all = [];
      const errs = [];
      for (let i = 0; i < urls.length; i++) {
        try {
          const r = await fetch(urls[i], { headers: { "user-agent": "Mozilla/5.0" }, cf: { cacheTtl: 300 } });
          if (!r.ok) { errs.push("캘린더" + (i + 1) + ": HTTP " + r.status); continue; }
          const txt = await r.text();
          if (!/BEGIN:VCALENDAR/.test(txt)) { errs.push("캘린더" + (i + 1) + ": iCal 형식이 아닙니다"); continue; }
          const nm = (txt.match(/X-WR-CALNAME:(.+)/) || [])[1];
          const evs = tdParseIcs(txt, fromStr, toStr, (nm || ("캘린더" + (i + 1))).trim());
          for (const e of evs) e.srcIdx = i;
          all.push(...evs);
        } catch (e) { errs.push("캘린더" + (i + 1) + ": " + e.message); }
      }
      all.sort((a, b) => (a.date === b.date ? (a.min || 0) - (b.min || 0) : a.date < b.date ? -1 : 1));
      const payload = JSON.stringify({ ok: true, at: Date.now(), from: fromStr, to: toStr, events: all, errors: errs });
      ctx.waitUntil(env.GAUGE_KV.put(cacheKey, payload, { expirationTtl: 3600 }));
      return new Response(payload, { headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404, headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: JSON_HEADERS });
  }
}

export default {
  async scheduled(event, env, ctx) {
    // UTC 4시 = 13:00 KST(장중 참고, 평일만) / UTC 7시 = 16:00 KST(종가 확정, 매일)
    const now = new Date();
    const utcH = now.getUTCHours();
    const day = now.getUTCDay();
    const weekday = day >= 1 && day <= 5;
    const session = utcH < 6 ? "intraday" : "close";
    if (session === "close") {
      // 시장 온도계는 거래일 16:00 KST 1회만, 코인 온도계는 주말 포함 매일 16:00 KST
      if (weekday) ctx.waitUntil(updateGauge(env));
      ctx.waitUntil(updateCryptoGauge(env));
    }
    if (weekday) ctx.waitUntil(slRefresh(env, { notify: true, session }));
    // 매주 월요일 16:00 KST — 회원 보유종목 주간 집계 텔레그램
    if (session === "close" && day === 1) ctx.waitUntil(authWatchlistTelegram(env, "주간 집계").catch(() => {}));
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // ── 무료 회원제: 인증 API + 전체 페이지 잠금 게이트 (api/data 경로는 게이트 제외) ──
    if (url.pathname.startsWith("/api/auth/")) {
      return authHandle(req, url, env, ctx);
    }
    const authRedir = await authGate(req, url, env);
    if (authRedir) return authRedir;

    if (url.pathname.startsWith("/api/todo/")) {
      return tdHandle(req, url, env, ctx);
    }

    if (url.pathname.startsWith("/api/risk/")) {
      return handleRisk(req, url, env);
    }

    if (url.pathname.startsWith("/api/stoploss/")) {
      return handleStopLoss(req, url, env);
    }

    if (url.pathname.startsWith("/api/journal/")) {
      return handleJournal(req, url, env, ctx);
    }

    if (url.pathname === "/data/stoploss.json") {
      const v = await env.GAUGE_KV.get("stoploss-result");
      return new Response(v || JSON.stringify({ ok: false, error: "아직 점검 결과가 없습니다. 새로 점검을 실행하세요." }),
        { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/sector-flow/token" && req.method === "POST") {
      return sfPushToken(req, env);
    }

    if (url.pathname === "/api/sector-flow/push-data" && req.method === "POST") {
      return sfPushData(req, env);
    }

    if (url.pathname.startsWith("/api/sector-flow/")) {
      return sfHandle(req, url, env);
    }

    if (url.pathname === "/data/sector-flow-live.json") {
      const v = await env.GAUGE_KV.get("sector-flow-live");
      return new Response(v || JSON.stringify({ ok: false, error: "라이브 스냅샷 없음" }), { headers: JSON_HEADERS });
    }

    if (url.pathname.startsWith("/api/supply/")) {
      return handleSupply(req, url, env, ctx);
    }

    if (url.pathname.startsWith("/api/masters/dart/")) {
      return handleMastersDart(req, url, env);
    }
    if (url.pathname.startsWith("/api/masters/fund/")) {
      const mcode = url.pathname.slice("/api/masters/fund/".length).replace(/[^0-9A-Za-z]/g, "");
      try {
        const mr = await fetch(`https://m.stock.naver.com/api/stock/${mcode}/integration`, { headers: CK_HEADERS });
        if (!mr.ok) throw new Error(`fund HTTP ${mr.status}`);
        const mj = await mr.json();
        const minfo = {};
        for (const x of mj.totalInfos || []) minfo[x.code] = x.value;
        return new Response(JSON.stringify({ ok: true, data: { code: mcode, name: mj.stockName || null, info: minfo } }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: JSON_HEADERS });
      }
    }
    if (url.pathname.startsWith("/api/cockpit/")) {
      return handleCockpit(req, url, ctx);
    }

    if (url.pathname.startsWith("/api/entry/")) {
      return handleEntry(req, url, ctx);
    }

    if (url.pathname.startsWith("/api/forensic/")) {
      return handleForensic(req, url, env);
    }

    if (url.pathname === "/api/gauge-refresh-request" && req.method === "POST") {
      // 홈 "일괄 갱신 요청" 버튼: ① 시장 온도계 즉시 서버 갱신 ② 나머지는 텔레그램으로 Claude 처리 요청
      const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
      ctx.waitUntil(updateGauge(env));
      ctx.waitUntil(updateCryptoGauge(env));
      ctx.waitUntil(slTelegram(env,
        "\uD83C\uDF21 <b>\uC628\uB3C4\uACC4 \uC77C\uAD04 \uAC31\uC2E0 \uC694\uCCAD</b>\n" +
        "\uC2DC\uC7A5\u00B7\uCF54\uC778 \uC628\uB3C4\uACC4\uB294 \uC989\uC2DC \uAC31\uC2E0\uC744 \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4.\n" +
        "\uAC70\uC2DC\u00B7\uAD70\uC911\uC2EC\uB9AC\u00B7\uC608\uC218\uAE08\uC740 Cowork\uC5D0\uC11C\n" +
        "<code>\uC628\uB3C4\uACC4 \uAC31\uC2E0 \uD050 \uCC98\uB9AC\uD574\uC918</code> \uB77C\uACE0 \uC785\uB825\uD558\uBA74 \uCC98\uB9AC\uB429\uB2C8\uB2E4.\n" +
        "\uC694\uCCAD \uC2DC\uAC01: " + stamp + " KST"));
      return new Response(JSON.stringify({ ok: true, requested_at: stamp }), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/refresh-gauge") {
      try {
        const d = await updateGauge(env);
        const summary = {};
        for (const ix of GAUGE_INDICES) {
          if (d[ix.key]) summary[ix.key] = { date: d[ix.key].date, score: d[ix.key].score, zone: d[ix.key].zone };
        }
        return new Response(JSON.stringify({
          ok: true, updated: d.updated, as_of: d.kospi?.date ?? null,
          indices: summary, warnings: d.warnings ?? null,
        }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    if (url.pathname === "/data/watchlist-all.json") {
      try {
        await authEnsureTables(env);
        const rows = await env.RISK_DB.prepare(
          "SELECT code, name, COUNT(*) AS holders, MAX(added_at) AS last_added FROM site_watchlist GROUP BY code ORDER BY holders DESC, last_added DESC").all();
        return new Response(JSON.stringify({ ok: true, updated: new Date().toISOString(), stocks: rows.results }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    if (url.pathname === "/data/watchlist-top.json") {
      const cached = await env.GAUGE_KV.get("wl-top-cache");
      if (cached) return new Response(cached, { headers: JSON_HEADERS });
      try {
        const s = await authWatchlistStats(env);
        const body = JSON.stringify({
          ok: true, updated: new Date().toISOString(), members: s.members,
          top: s.top.slice(0, 10).map(t => ({ code: t.code, name: t.name, holders: t.holders })),
        });
        await env.GAUGE_KV.put("wl-top-cache", body, { expirationTtl: 600 });
        return new Response(body, { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    if (url.pathname === "/data/market-gauge.json") {
      const v = await env.GAUGE_KV.get("market-gauge");
      if (v) return new Response(v, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/data/crypto-gauge.json") {
      const v = await env.GAUGE_KV.get("crypto-gauge");
      if (v) return new Response(v, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/refresh-crypto-gauge") {
      try {
        const d = await updateCryptoGauge(env);
        const summary = {};
        for (const c of CRYPTO_COINS) {
          const h = d.coins[c.sym] && d.coins[c.sym].history;
          if (h && h.length) {
            const s = h[h.length - 1];
            summary[c.sym] = { date: s.date, score: s.score, zone: s.zone, kimchi_pct: s.kimchi_pct ?? null, verdict: s.entry ? s.entry.verdict : null };
          }
        }
        return new Response(JSON.stringify({ ok: true, updated: d.updated, coins: summary, warnings: d.warnings ?? null }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    if (url.pathname.startsWith("/api/receipts/")) {
      return handleReceipts(req, url, env, ctx);
    }

    if (url.pathname.startsWith("/api/reports/")) {
      return handleReports(req, url, env, ctx);
    }

    const assetRes = await env.ASSETS.fetch(req);

    // PDF를 주소창/링크로 직접 열면(모바일에서 흔함) 브라우저 기본 PDF 화면으로 넘어가
    // 우리 HTML이 사라져 뒤로·홈 버튼이 없어진다. 최상위 이동이면 뒤로/홈 바 + 자체 뷰어가
    // 붙은 HTML로 감싸 돌려준다. ?raw=1 이면 원본 PDF를 그대로 준다(다운로드·뷰어 fetch용).
    if ((assetRes.headers.get("content-type") || "").includes("application/pdf") && assetRes.status === 200) {
      // ?dl=1 : 다운로드 전용 — 첨부파일로 내려 화면에 인라인 표시되지 않게 한다
      if (url.searchParams.has("dl")) {
        const fn = decodeURIComponent(url.pathname.split("/").pop() || "report.pdf");
        const h = new Headers(assetRes.headers);
        h.set("content-disposition", `attachment; filename="${fn.replace(/"/g, "")}"`);
        return new Response(assetRes.body, { status: 200, headers: h });
      }
      // ?raw=1 : 원본 PDF 바이트 (내장 뷰어 PDF.js·iframe 전용)
      if (url.searchParams.has("raw")) return assetRes;
      // 그 외 PDF 주소는 무조건 뒤로/홈 바 + 내장 뷰어가 달린 래퍼 HTML.
      // 헤더 판별(sec-fetch/accept)은 iOS Safari·서비스워커 경유 시 신뢰할 수 없어 쓰지 않는다.
      return pdfWrapperPage(url);
    }

    if ((assetRes.headers.get("content-type") || "").includes("text/html")) {
      const isPost = url.pathname.startsWith("/posts/");
      const isHome = url.pathname === "/" || url.pathname === "/index.html";
      const isPdfView = url.pathname === "/research-digest.html" || url.pathname === "/crypto-report.html";
      return new HTMLRewriter().on("head", {
        element(el) {
          el.append(`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "33e842c948b94e4787347cd2487af700"}'></script>`, { html: true });
          // 리포트 페이지에는 종목 도구 연결 위젯을 자동 주입 (기존·신규 게시물 공통)
          if (isPost) el.append(`<script defer src="/post-tools.js?v=2026080802"></script>`, { html: true });
          // 리포트·PDF 뷰어 페이지에는 뒤로/홈 내비를 자동 주입 (상단 고정 + 우하단 플로팅)
          if (isPost || isPdfView) el.append(`<script defer src="/post-nav.js?v=2026080802"></script>`, { html: true });
          // PDF는 페이지 안에서 직접 렌더링 (iOS Safari가 PDF 주소로 통째 이동하는 것을 방지)
          if (isPost || isPdfView) el.append(`<script defer src="/pdf-viewer.js?v=2026080802"></script>`, { html: true });
          // 홈을 제외한 모든 페이지에 공용 플로팅 내비 주입
          if (!isHome) el.append(`<script defer src="/site-nav.js?v=2026080802"></script>`, { html: true });
        }
      }).transform(assetRes);
    }
    return assetRes;
  },
};

/* ═══════════════════ 수급 콕핏 (/api/supply/*) ═══════════════════
   영웅문4 수급분석툴 방법론: 매집수량 = 누적순매수 - 역대최저점(최대분산),
   매집고점 = max(매집수량, -최저점), 분산비율 = 매집수량/매집고점.
   데이터: 키움 REST ka10059 (키는 D1 app_config, 토큰은 KV 캐시) */

const SUP_CATS = ["개인","외국인","기관계","금융투자","보험","투신","기타금융","은행","연기금","사모펀드","국가","기타법인","내외국인"];
const SUP_FIELDS = { 개인:"ind_invsr", 외국인:"frgnr_invsr", 기관계:"orgn", 금융투자:"fnnc_invt",
  보험:"insrnc", 투신:"invtrt", 기타금융:"etc_fnnc", 은행:"bank", 연기금:"penfnd_etc",
  사모펀드:"samo_fund", 국가:"natn", 기타법인:"etc_corp", 내외국인:"natfor" };
const SUP_FORCE = ["외국인","금융투자","보험","투신","기타금융","은행","연기금","사모펀드","국가","기타법인"];

function supNum(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/,/g, "").replace(/^\+/, ""));
  return isNaN(n) ? 0 : n;
}

async function supToken(env) {
  const cached = await env.GAUGE_KV.get("kiwoom-token");
  if (cached) return cached;
  const rs = await env.RISK_DB.prepare(
    "SELECT k,v FROM app_config WHERE k IN ('kiwoom_app_key','kiwoom_secret_key')").all();
  const kv = {};
  for (const r of rs.results) kv[r.k] = r.v;
  if (!kv.kiwoom_app_key || !kv.kiwoom_secret_key) throw new Error("키움 앱키 미설정 (D1 app_config)");
  const r = await fetch("https://api.kiwoom.com/oauth2/token", {
    method: "POST", headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: kv.kiwoom_app_key, secretkey: kv.kiwoom_secret_key }),
  });
  const j = await r.json();
  if (!j.token) {
    // 지정단말기 인증 등으로 워커에서 발급 불가 → 로컬 스킬이 밀어넣은 토큰 폴백
    const t = await env.RISK_DB.prepare("SELECT v FROM app_config WHERE k='kiwoom_token'").first();
    const exp = await env.RISK_DB.prepare("SELECT v FROM app_config WHERE k='kiwoom_token_exp'").first();
    if (t && t.v && exp && Number(exp.v) > Date.now() + 60e3) {
      const ttl = Math.max(60, Math.min(3600 * 20, Math.floor((Number(exp.v) - Date.now()) / 1000)));
      await env.GAUGE_KV.put("kiwoom-token", t.v, { expirationTtl: ttl });
      return t.v;
    }
    throw new Error("키움 토큰 발급 실패: " + (j.return_msg || r.status) +
      " — 로컬 저장 토큰도 없거나 만료. Claude에서 '업종 수급 업데이트'를 실행하면 토큰이 갱신됩니다.");
  }
  await env.GAUGE_KV.put("kiwoom-token", j.token, { expirationTtl: 3600 * 20 });
  return j.token;
}

async function supFetchFlows(code, fromYmd, env) {
  const token = await supToken(env);
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  const byDate = {};
  let contYn = "N", nextKey = "", pages = 0;
  while (pages < 30) {
    const h = { "content-type": "application/json;charset=UTF-8", authorization: "Bearer " + token, "api-id": "ka10059" };
    if (contYn === "Y") { h["cont-yn"] = "Y"; h["next-key"] = nextKey; }
    const r = await fetch("https://api.kiwoom.com/api/dostk/stkinfo", {
      method: "POST", headers: h,
      body: JSON.stringify({ dt: today, stk_cd: code, amt_qty_tp: "2", trde_tp: "0", unit_tp: "1" }),
    });
    if (!r.ok) throw new Error("ka10059 HTTP " + r.status);
    const j = await r.json();
    const list = j.stk_invsr_orgn || [];
    if (String(j.return_code ?? "0") !== "0" && !list.length) throw new Error("ka10059: " + (j.return_msg || "오류"));
    let oldest = null;
    for (const row of list) {
      const d = String(row.dt || "").replace(/-/g, "").slice(0, 8);
      if (d.length !== 8) continue;
      oldest = d;
      if (d < fromYmd || byDate[d]) continue;
      const rec = { date: d, close: Math.abs(supNum(row.cur_prc)), volume: supNum(row.acc_trde_qty) };
      for (const c of SUP_CATS) rec[c] = supNum(row[SUP_FIELDS[c]]);
      byDate[d] = rec;
    }
    contYn = r.headers.get("cont-yn") || "N";
    nextKey = r.headers.get("next-key") || "";
    pages++;
    if (contYn !== "Y" || !list.length || (oldest && oldest < fromYmd)) break;
  }
  return Object.keys(byDate).sort().map(k => byDate[k]);
}

function supMetrics(net) {
  let s = 0;
  const cum = net.map(v => (s += v));
  let low = 0;
  for (const c of cum) if (c < low) low = c;
  const acc = cum.map(c => Math.round(c - low));
  let peak = -low;
  for (const a of acc) if (a > peak) peak = a;
  const cur = acc.length ? acc[acc.length - 1] : 0;
  const avg = (arr, n) => { const t = arr.slice(-n); return t.length ? t.reduce((x, y) => x + y, 0) / t.length : 0; };
  const sum = (arr, n) => arr.slice(-n).reduce((x, y) => x + y, 0);
  const a5 = avg(acc, 5), a20 = avg(acc, 20), a60 = avg(acc, 60), s20 = sum(net, 20);
  const trend = (a5 >= a20 && a20 >= a60 && s20 > 0) ? "매집" : (a5 <= a20 && a20 <= a60 && s20 < 0) ? "분산" : "중립";
  return { cum: Math.round(s), acc: cur, peak: Math.round(peak),
    disp: peak > 0 ? +(cur / peak).toFixed(4) : null, capacity: Math.round(peak - cur),
    n5: Math.round(sum(net, 5)), n20: Math.round(s20), n60: Math.round(sum(net, 60)), trend, _acc: acc };
}

async function handleSupply(req, url, env, ctx) {
  try {
    // ── 분석 요청 큐 ──
    if (url.pathname === "/api/supply/requests") {
      const v = await env.GAUGE_KV.get("supply-requests");
      return new Response(v || "[]", { headers: JSON_HEADERS });
    }
    if (url.pathname === "/api/supply/request" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const code = String(b.code || "").replace(/[^0-9A-Za-z]/g, "");
      const name = String(b.name || "").slice(0, 30);
      if (code.length !== 6) return new Response(JSON.stringify({ ok: false, error: "코드 오류" }), { status: 400, headers: JSON_HEADERS });
      let list = JSON.parse((await env.GAUGE_KV.get("supply-requests")) || "[]");
      if (!list.some(x => x.code === code)) {
        list.push({ code, name, ts: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16) });
        list = list.slice(-50);
        await env.GAUGE_KV.put("supply-requests", JSON.stringify(list));
      }
      return new Response(JSON.stringify({ ok: true, queued: list.length }), { headers: JSON_HEADERS });
    }
    if (url.pathname === "/api/supply/request-done") {
      const code = (url.searchParams.get("code") || "").replace(/[^0-9A-Za-z]/g, "");
      let list = JSON.parse((await env.GAUGE_KV.get("supply-requests")) || "[]");
      list = list.filter(x => x.code !== code);
      await env.GAUGE_KV.put("supply-requests", JSON.stringify(list));
      return new Response(JSON.stringify({ ok: true, remaining: list.length }), { headers: JSON_HEADERS });
    }
    const m = url.pathname.match(/^\/api\/supply\/analyze\/([0-9A-Za-z]{6})$/);
    if (!m) return new Response(JSON.stringify({ ok: false, error: "경로: /api/supply/analyze/{6자리코드}?years=3" }),
      { status: 404, headers: JSON_HEADERS });
    const code = m[1];
    const years = Math.min(Math.max(parseInt(url.searchParams.get("years") || "3", 10) || 3, 1), 10);
    const refresh = url.searchParams.get("refresh") === "1";
    const kvKey = `supply:${code}:${years}`;
    if (!refresh) {
      const hit = await env.GAUGE_KV.get(kvKey);
      if (hit) return new Response(hit, { headers: JSON_HEADERS });
    }
    const fromD = new Date(Date.now() + 9 * 3600e3);
    fromD.setFullYear(fromD.getFullYear() - years);
    const fromYmd = fromD.toISOString().slice(0, 10).replace(/-/g, "");
    const rows = await supFetchFlows(code, fromYmd, env);
    if (rows.length < 60) throw new Error(`데이터 부족 (${rows.length}일)`);
    const nets = {};
    for (const c of SUP_CATS) nets[c] = rows.map(r => r[c]);
    nets["세력합"] = rows.map(r => SUP_FORCE.reduce((s, c) => s + r[c], 0));
    const cats = {}, accSeries = {};
    for (const [c, net] of Object.entries(nets)) {
      const mt = supMetrics(net);
      accSeries[c] = mt._acc;
      delete mt._acc;
      cats[c] = mt;
    }
    const share = SUP_CATS.filter(c => c !== "기관계");
    const tp = share.reduce((s, c) => s + cats[c].peak, 0) || 1;
    const tc = share.reduce((s, c) => s + cats[c].acc, 0) || 1;
    for (const c of share) {
      cats[c].leadShare = +(cats[c].peak / tp).toFixed(4);
      cats[c].holdShare = +(cats[c].acc / tc).toFixed(4);
    }
    const splits = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i].close / (rows[i - 1].close || 1);
      if (rows[i - 1].close > 0 && (r < 0.55 || r > 1.45)) splits.push(rows[i].date);
    }
    const kstH = new Date(Date.now() + 9 * 3600e3).getUTCHours();
    const intraday = kstH >= 9 && kstH < 16;
    const out = JSON.stringify({
      ok: true, code, years, asof: rows[rows.length - 1].date, close: rows[rows.length - 1].close,
      days: rows.length, intraday, splits, categories: cats,
      series: { dates: rows.map(r => r.date), close: rows.map(r => r.close),
        개인: accSeries["개인"], 세력합: accSeries["세력합"], 외국인: accSeries["외국인"],
        기관계: accSeries["기관계"], 연기금: accSeries["연기금"], 사모펀드: accSeries["사모펀드"],
        금융투자: accSeries["금융투자"], 투신: accSeries["투신"] },
    });
    ctx.waitUntil(env.GAUGE_KV.put(kvKey, out, { expirationTtl: intraday ? 900 : 21600 }));
    return new Response(out, { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }),
      { status: 500, headers: JSON_HEADERS });
  }
}


/* ═══════════════════ 업종 수급 (/api/sector-flow/*) ═══════════════════
   sector-flow.html의 [최신 데이터 갱신] 버튼용.
   ka20006(업종 일봉: 거래일 달력+지수) + ka10051(업종별 투자자 순매수, 억원)로
   since 이후 거래일의 종합(KOSPI/KOSDAQ) 데이터를 반환하고 KV에 스냅샷 저장.
   ※ 엑셀 파일 갱신은 로컬 sector-flow 스킬 담당 — 여기는 차트 라이브 갱신 전용. */

const SF_MKTS = {
  kospi: { mrkt_tp: "0", inds_cd: "001", total: "종합(KOSPI)" },
  kosdaq: { mrkt_tp: "1", inds_cd: "101", total: "종합(KOSDAQ)" },
};

async function sfKiwoom(path, apiId, body, token) {
  const r = await fetch("https://api.kiwoom.com" + path, {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8", authorization: "Bearer " + token, "api-id": apiId },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (String(j.return_code) !== "0") throw new Error(apiId + " 오류: " + (j.return_msg || r.status));
  return j;
}

async function sfHandle(req, url, env) {
  if (!url.pathname.endsWith("/refresh")) {
    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404, headers: JSON_HEADERS });
  }
  try {
    const token = await supToken(env);
    const todayKst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
    const since = (url.searchParams.get("since") || "").replace(/[^0-9]/g, "");
    const out = {};
    for (const [key, mkt] of Object.entries(SF_MKTS)) {
      const chart = await sfKiwoom("/api/dostk/chart", "ka20006", { inds_cd: mkt.inds_cd, base_dt: todayKst }, token);
      const idx = {};
      for (const b of chart.inds_dt_pole_qry || []) {
        if (b.dt) idx[b.dt] = Math.abs(supNum(b.cur_prc)) / 100;
      }
      let days = Object.keys(idx).sort();
      const s = since || days[days.length - 1];
      days = days.filter(d => d >= s).slice(-15);
      const rows = [];
      for (const d of days) {
        const j = await sfKiwoom("/api/dostk/sect", "ka10051",
          { mrkt_tp: mkt.mrkt_tp, amt_qty_tp: "0", base_dt: d, stex_tp: "3" }, token);
        const t = (j.inds_netprps || []).find(x => (x.inds_nm || "").trim() === mkt.total);
        if (!t) continue;
        rows.push({
          dt: d,
          ind: Math.round(supNum(t.ind_netprps)),
          frgnr: Math.round(supNum(t.frgnr_netprps)),
          orgn: Math.round(supNum(t.orgn_netprps)),
          index: idx[d] || null,
        });
      }
      out[key] = rows;
    }
    const payload = JSON.stringify({
      ok: true,
      updated: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "),
      markets: out,
    });
    await env.GAUGE_KV.put("sector-flow-live", payload, { expirationTtl: 86400 * 5 });
    return new Response(payload, { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.stack || e) }), { headers: JSON_HEADERS });
  }
}

/* 로컬 스킬이 발급한 키움 토큰을 저장 (지정단말기 인증 우회용).
   POST /api/sector-flow/token  {secret, token, expires_at(ms epoch)} */
async function sfPushToken(req, env) {
  try {
    const b = await req.json();
    const sec = await env.RISK_DB.prepare("SELECT v FROM app_config WHERE k='sf_push_secret'").first();
    if (!sec || !b.secret || b.secret !== sec.v) {
      return new Response(JSON.stringify({ ok: false, error: "인증 실패" }), { status: 403, headers: JSON_HEADERS });
    }
    if (!b.token) return new Response(JSON.stringify({ ok: false, error: "token 누락" }), { status: 400, headers: JSON_HEADERS });
    const exp = Number(b.expires_at) || (Date.now() + 3600e3 * 20);
    await env.RISK_DB.prepare("INSERT INTO app_config (k,v) VALUES ('kiwoom_token', ?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(b.token)).run();
    await env.RISK_DB.prepare("INSERT INTO app_config (k,v) VALUES ('kiwoom_token_exp', ?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(exp)).run();
    const ttl = Math.max(60, Math.min(3600 * 20, Math.floor((exp - Date.now()) / 1000)));
    await env.GAUGE_KV.put("kiwoom-token", String(b.token), { expirationTtl: ttl });
    return new Response(JSON.stringify({ ok: true, expires_at: exp }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
  }
}

/* 로컬 스킬이 갱신한 수급 데이터 스냅샷 저장 — 페이지 로드 시 자동 병합됨.
   POST /api/sector-flow/push-data  {secret, updated, markets:{kospi:[...],kosdaq:[...]}} */
async function sfPushData(req, env) {
  try {
    const b = await req.json();
    const sec = await env.RISK_DB.prepare("SELECT v FROM app_config WHERE k='sf_push_secret'").first();
    if (!sec || !b.secret || b.secret !== sec.v) {
      return new Response(JSON.stringify({ ok: false, error: "인증 실패" }), { status: 403, headers: JSON_HEADERS });
    }
    if (!b.markets || !b.markets.kospi || !b.markets.kosdaq) {
      return new Response(JSON.stringify({ ok: false, error: "markets 누락" }), { status: 400, headers: JSON_HEADERS });
    }
    const payload = JSON.stringify({
      ok: true,
      updated: b.updated || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "),
      markets: { kospi: b.markets.kospi, kosdaq: b.markets.kosdaq },
      source: "skill",
    });
    await env.GAUGE_KV.put("sector-flow-live", payload, { expirationTtl: 86400 * 7 });
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
  }
}

/* ═══════════════ 증권사 리포트 요약 요청 큐 (/api/reports/*) ═══════════════
   report-summary.html: 종목 검색 → 게시된 요약이 없으면 요청 등록(KV 큐).
   로컬 Claude 정기 작업이 requests를 수거해 최근 6개월 증권사 리포트를
   수집·요약(PDF 5장 이내)해 게시한 뒤 complete로 큐에서 제거한다. */

const RQ_KEY = "report-requests";

async function rqLoad(env) {
  try { return JSON.parse((await env.GAUGE_KV.get(RQ_KEY)) || "[]"); } catch (e) { return []; }
}

async function handleReports(req, url, env, ctx) {
  const p = url.pathname.slice("/api/reports/".length);
  try {
    if (p === "requests") {
      const list = await rqLoad(env);
      return new Response(JSON.stringify({ ok: true, requests: list }), { headers: JSON_HEADERS });
    }
    if (p === "request" && req.method === "POST") {
      const b = await req.json();
      const code = String(b.code || "").replace(/[^0-9A-Za-z]/g, "");
      const name = String(b.name || "").trim().slice(0, 40);
      if (!/^\d{6}$/.test(code) || !name) {
        return new Response(JSON.stringify({ ok: false, error: "code(6자리)와 name이 필요합니다" }), { status: 400, headers: JSON_HEADERS });
      }
      const list = await rqLoad(env);
      if (list.find(x => x.code === code)) {
        return new Response(JSON.stringify({ ok: true, dup: true, message: "이미 대기 중인 요청입니다." }), { headers: JSON_HEADERS });
      }
      if (list.length >= 20) {
        return new Response(JSON.stringify({ ok: false, error: "대기 요청이 가득 찼습니다(20건)." }), { status: 429, headers: JSON_HEADERS });
      }
      list.push({ code, name, market: String(b.market || "").slice(0, 12), requested_at: kstNow(), status: "pending" });
      await env.GAUGE_KV.put(RQ_KEY, JSON.stringify(list));
      ctx.waitUntil(slTelegram(env,
        `📝 <b>리포트 요약 요청</b>\n${name}(${code})\n정기 작업이 자동 처리합니다. 바로 처리하려면 Cowork에서 "리포트 요약 큐 처리해줘"라고 말하세요.`));
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }
    if (p === "complete" && req.method === "POST") {
      const b = await req.json();
      const sec = await env.RISK_DB.prepare("SELECT v FROM app_config WHERE k='report_secret'").first();
      if (!sec || !b.secret || b.secret !== sec.v) {
        return new Response(JSON.stringify({ ok: false, error: "인증 실패" }), { status: 403, headers: JSON_HEADERS });
      }
      const code = String(b.code || "");
      const list = await rqLoad(env);
      const next = list.filter(x => x.code !== code);
      await env.GAUGE_KV.put(RQ_KEY, JSON.stringify(next));
      return new Response(JSON.stringify({ ok: true, removed: list.length - next.length }), { headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown endpoint" }), { status: 404, headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
  }
}

// redeploy trigger: force build of HEAD (tolerant inflater)

/* ═══════════════ 영수증 가계부 (/api/receipts/*) ═══════════════
   receipt-upload.html: 핸드폰에서 영수증 사진 업로드 → KV 큐 적재.
   로컬 Claude(receipt-ledger 스킬)가 큐를 수거해 판독 후 save로 D1
   receipts 테이블에 기입하고 큐·이미지를 제거한다. 인증은 report_secret 재사용. */

const RCPT_Q = "receipt-queue";

async function rcptQueue(env) {
  try { return JSON.parse((await env.GAUGE_KV.get(RCPT_Q)) || "[]"); } catch (e) { return []; }
}

async function rcptAuth(env, s) {
  if (!s) return false;
  const row = await env.RISK_DB.prepare("SELECT v FROM app_config WHERE k='report_secret'").first();
  return !!(row && s === row.v);
}

async function handleReceipts(req, url, env, ctx) {
  const p = url.pathname.slice("/api/receipts/".length);
  const bad = (msg, code) => new Response(JSON.stringify({ ok: false, error: msg }), { status: code || 400, headers: JSON_HEADERS });
  try {
    if (p === "upload" && req.method === "POST") {
      const b = await req.json();
      const img = String(b.image || "");
      if (!img.startsWith("data:image/") || img.length > 8000000) return bad("이미지 형식 오류 또는 8MB 초과");
      const list = await rcptQueue(env);
      if (list.length >= 60) return bad("대기 큐가 가득 찼습니다(60건). 먼저 처리해 주세요.", 429);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      await env.GAUGE_KV.put("receipt:img:" + id, img, { expirationTtl: 2592000 });
      list.push({ id, note: String(b.note || "").slice(0, 80), card: String(b.card || "").slice(0, 20), uploaded_at: kstNow() });
      await env.GAUGE_KV.put(RCPT_Q, JSON.stringify(list));
      if (b.notify !== false && list.length === 1) {
        ctx.waitUntil(slTelegram(env,
          `🧾 <b>영수증 업로드</b>\n대기 ${list.length}건. Cowork에서 "영수증 큐 처리해줘"라고 말하면 원장에 기입됩니다.`));
      }
      return new Response(JSON.stringify({ ok: true, id, queued: list.length }), { headers: JSON_HEADERS });
    }
    if (p === "queue") {
      return new Response(JSON.stringify({ ok: true, requests: await rcptQueue(env) }), { headers: JSON_HEADERS });
    }
    if (p.startsWith("img/")) {
      if (!(await rcptAuth(env, url.searchParams.get("s")))) return bad("인증 실패", 403);
      const v = await env.GAUGE_KV.get("receipt:img:" + p.slice(4));
      if (!v) return bad("이미지 없음", 404);
      return new Response(v, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (p === "save" && req.method === "POST") {
      const b = await req.json();
      if (!(await rcptAuth(env, b.secret))) return bad("인증 실패", 403);
      const rows = Array.isArray(b.rows) ? b.rows : [];
      const now = kstNow();
      const stmts = rows.map(r =>
        env.RISK_DB.prepare("INSERT INTO receipts(date,merchant,amount,account,memo,card,img_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .bind(String(r.date || "").slice(0, 10), String(r.merchant || "").slice(0, 60), Math.round(+r.amount || 0),
                String(r.account || "기타").slice(0, 20), String(r.memo || "").slice(0, 120),
                String(r.card || "").slice(0, 20), String(r.img_id || ""), now));
      if (stmts.length) await env.RISK_DB.batch(stmts);
      const done = new Set(rows.map(r => String(r.img_id || "")).filter(Boolean));
      for (const x of (Array.isArray(b.clear_ids) ? b.clear_ids : [])) done.add(String(x));
      if (done.size) {
        const list = (await rcptQueue(env)).filter(x => !done.has(x.id));
        await env.GAUGE_KV.put(RCPT_Q, JSON.stringify(list));
        for (const id of done) ctx.waitUntil(env.GAUGE_KV.delete("receipt:img:" + id));
      }
      return new Response(JSON.stringify({ ok: true, inserted: rows.length }), { headers: JSON_HEADERS });
    }
    if (p === "ledger") {
      const from = (url.searchParams.get("from") || "0000-01-01").slice(0, 10);
      const to = (url.searchParams.get("to") || "9999-12-31").slice(0, 10);
      const r = await env.RISK_DB.prepare(
        "SELECT id,date,merchant,amount,account,memo,card FROM receipts WHERE date>=? AND date<=? ORDER BY date DESC, id DESC LIMIT 2000")
        .bind(from, to).all();
      return new Response(JSON.stringify({ ok: true, rows: r.results }), { headers: JSON_HEADERS });
    }
    if (p === "update" && req.method === "POST") {
      const b = await req.json();
      if (!(await rcptAuth(env, b.secret))) return bad("인증 실패", 403);
      const allowed = ["date", "merchant", "amount", "account", "memo", "card"];
      const sets = [], vals = [];
      for (const k of allowed) if (b[k] !== undefined) { sets.push(k + "=?"); vals.push(k === "amount" ? Math.round(+b[k] || 0) : String(b[k])); }
      if (!sets.length || !b.id) return bad("수정할 필드/id 없음");
      vals.push(+b.id);
      await env.RISK_DB.prepare("UPDATE receipts SET " + sets.join(",") + " WHERE id=?").bind(...vals).run();
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }
    if (p === "delete" && req.method === "POST") {
      const b = await req.json();
      if (!(await rcptAuth(env, b.secret))) return bad("인증 실패", 403);
      if (b.img_id) {
        const list = (await rcptQueue(env)).filter(x => x.id !== String(b.img_id));
        await env.GAUGE_KV.put(RCPT_Q, JSON.stringify(list));
        ctx.waitUntil(env.GAUGE_KV.delete("receipt:img:" + String(b.img_id)));
        return new Response(JSON.stringify({ ok: true, scope: "queue" }), { headers: JSON_HEADERS });
      }
      if (!b.id) return bad("id 없음");
      await env.RISK_DB.prepare("DELETE FROM receipts WHERE id=?").bind(+b.id).run();
      return new Response(JSON.stringify({ ok: true, scope: "ledger" }), { headers: JSON_HEADERS });
    }
    return bad("unknown endpoint", 404);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSON_HEADERS });
  }
}

/* ═══════════════════ 무료 회원제 (site membership) ═══════════════════
   전 페이지 잠금: HTML·게시물 PDF는 로그인 세션 필요.
   /api/* · /data/* · 정적 리소스(js/css/png/json)는 기존 그대로 (자동화 스킬 영향 없음).
   회원/세션: D1(risk-manager) site_members / site_sessions. 가입 즉시 열람 + 텔레그램 알림. */

const AUTH_COOKIE = "ti_sess";
const AUTH_SESSION_DAYS = 90;
const AUTH_PW_ITER = 50000;
const AUTH_OPEN_PAGES = new Set(["/login.html", "/signup.html", "/login", "/signup", "/terms.html", "/terms"]);

async function authEnsureTables(env) {
  await env.RISK_DB.batch([
    env.RISK_DB.prepare(
      "CREATE TABLE IF NOT EXISTS site_members(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE," +
      "pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_iter INTEGER NOT NULL," +
      "status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, last_login_at TEXT, agreed_at TEXT)"),
    env.RISK_DB.prepare(
      "CREATE TABLE IF NOT EXISTS site_sessions(" +
      "token_hash TEXT PRIMARY KEY, member_id INTEGER NOT NULL," +
      "created_at TEXT NOT NULL, expires_at TEXT NOT NULL)"),
  ]);
  // 기존 테이블 보강 (컬럼이 이미 있으면 무시)
  try { await env.RISK_DB.prepare("ALTER TABLE site_members ADD COLUMN agreed_at TEXT").run(); } catch (e) {}
  await env.RISK_DB.prepare(
    "CREATE TABLE IF NOT EXISTS site_watchlist(" +
    "member_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL," +
    "added_at TEXT NOT NULL, PRIMARY KEY(member_id, code))").run();
}

function authRandHex(n) {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authHashPw(pw, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function authSetCookie(token, maxAge) {
  return AUTH_COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}

function authGetToken(req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)ti_sess=([0-9a-f]{64})/);
  return m ? m[1] : null;
}

function authEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function authNowKST() {
  return new Date(Date.now() + 9 * 36e5).toISOString().replace("T", " ").slice(0, 19);
}

async function authNewSession(env, memberId) {
  const token = authRandHex(32);
  const th = await rkSha256(token);
  const now = new Date();
  const exp = new Date(now.getTime() + AUTH_SESSION_DAYS * 86400e3);
  await env.RISK_DB.prepare("INSERT INTO site_sessions(token_hash,member_id,created_at,expires_at) VALUES(?,?,?,?)")
    .bind(th, memberId, now.toISOString(), exp.toISOString()).run();
  return token;
}

async function authMember(req, env) {
  const token = authGetToken(req);
  if (!token) return null;
  try {
    const th = await rkSha256(token);
    const row = await env.RISK_DB.prepare(
      "SELECT m.id AS id, m.name AS name, m.email AS email, m.status AS status, s.expires_at AS expires_at " +
      "FROM site_sessions s JOIN site_members m ON m.id = s.member_id WHERE s.token_hash = ?").bind(th).first();
    if (!row || row.status !== "active") return null;
    if (String(row.expires_at) < new Date().toISOString()) return null;
    return row;
  } catch (e) { return null; }
}

function authIsGatedPath(req, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/data/")) return false;
  if (AUTH_OPEN_PAGES.has(p)) return false;
  if (p === "/" || p === "/index.html" || p === "/index") return false; // 홈은 공개 (로그인·가입 진입점)
  if (p.endsWith("/") || p.endsWith(".html")) return true;
  if (p.startsWith("/posts/") && p.endsWith(".pdf")) return true;
  if (!p.slice(1).includes(".")) return true; // 확장자 없는 경로 (자동 .html 매핑 대비)
  return false;
}

async function authGate(req, url, env) {
  if (!authIsGatedPath(req, url)) return null;
  const m = await authMember(req, env);
  if (m) return null;
  const next = encodeURIComponent(url.pathname + url.search);
  return Response.redirect(url.origin + "/login.html?next=" + next, 302);
}

function authJson(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...(extraHeaders || {}) } });
}

async function authHandle(req, url, env, ctx) {
  const p = url.pathname.slice("/api/auth/".length).replace(/\/+$/, "");
  try {
    if (p === "watchlist") {
      const m = await authMember(req, env);
      if (!m) return authJson(401, { ok: false, error: "로그인이 필요합니다" });
      await authEnsureTables(env);
      if (req.method === "GET") {
        const rows = await env.RISK_DB.prepare(
          "SELECT code,name,added_at FROM site_watchlist WHERE member_id=? ORDER BY added_at").bind(m.id).all();
        return authJson(200, { ok: true, stocks: rows.results });
      }
      if (req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const op = String(b.op || "add");
        const code = String(b.code || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 8);
        if (!code) return authJson(400, { ok: false, error: "종목코드가 올바르지 않습니다" });
        if (op === "remove") {
          const gone = await env.RISK_DB.prepare(
            "SELECT name FROM site_watchlist WHERE member_id=? AND code=?").bind(m.id, code).first().catch(() => null);
          await env.RISK_DB.prepare("DELETE FROM site_watchlist WHERE member_id=? AND code=?").bind(m.id, code).run();
          ctx.waitUntil(env.GAUGE_KV.delete("wl-top-cache").catch(() => {}));
          if (gone) ctx.waitUntil(slTelegram(env,
            "\uD83D\uDDD1 <b>\uC885\uBAA9 \uC0AD\uC81C</b> \u2014 " + authEsc(m.name) + "\n" +
            authEsc(gone.name) + " (" + code + ")").catch(() => {}));
          return authJson(200, { ok: true });
        }
        const name = String(b.name || "").trim().slice(0, 40);
        if (!name) return authJson(400, { ok: false, error: "종목명이 필요합니다" });
        const cnt = await env.RISK_DB.prepare("SELECT COUNT(*) AS c FROM site_watchlist WHERE member_id=?").bind(m.id).first();
        if (cnt && cnt.c >= 30) return authJson(400, { ok: false, error: "종목은 최대 30개까지 등록할 수 있습니다" });
        await env.RISK_DB.prepare(
          "INSERT OR REPLACE INTO site_watchlist(member_id,code,name,added_at) VALUES(?,?,?,?)")
          .bind(m.id, code, name, new Date().toISOString()).run();
        ctx.waitUntil(env.GAUGE_KV.delete("wl-top-cache").catch(() => {}));
        ctx.waitUntil(slTelegram(env,
          "\uD83D\uDCCC <b>\uC885\uBAA9 \uB4F1\uB85D</b> \u2014 " + authEsc(m.name) + "\n" +
          authEsc(name) + " (" + code + ")").catch(() => {}));
        return authJson(200, { ok: true });
      }
      return authJson(405, { ok: false, error: "method not allowed" });
    }

    if (p === "me" && req.method === "GET") {
      const m = await authMember(req, env);
      if (!m) return authJson(401, { ok: false, error: "로그인이 필요합니다" });
      return authJson(200, { ok: true, member: { name: m.name, email: m.email } });
    }

    if (p === "signup" && req.method === "POST") {
      await authEnsureTables(env);
      const b = await req.json().catch(() => ({}));
      const name = String(b.name || "").trim().slice(0, 40);
      const email = String(b.email || "").trim().toLowerCase();
      const pw = String(b.password || "");
      if (!name) return authJson(400, { ok: false, error: "이름을 입력해 주세요" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120)
        return authJson(400, { ok: false, error: "올바른 이메일 주소를 입력해 주세요" });
      if (pw.length < 8 || pw.length > 100)
        return authJson(400, { ok: false, error: "비밀번호는 8자 이상이어야 합니다" });
      if (b.agree !== true)
        return authJson(400, { ok: false, error: "이용약관 및 개인정보처리방침에 동의해 주세요" });
      const dup = await env.RISK_DB.prepare("SELECT id FROM site_members WHERE email=?").bind(email).first();
      if (dup) return authJson(409, { ok: false, error: "이미 가입된 이메일입니다. 로그인해 주세요." });
      const salt = authRandHex(16);
      const hash = await authHashPw(pw, salt, AUTH_PW_ITER);
      await env.RISK_DB.prepare(
        "INSERT INTO site_members(name,email,pw_hash,pw_salt,pw_iter,status,created_at,agreed_at) VALUES(?,?,?,?,?,'active',?,?)")
        .bind(name, email, hash, salt, AUTH_PW_ITER, new Date().toISOString(), new Date().toISOString()).run();
      const row = await env.RISK_DB.prepare("SELECT id FROM site_members WHERE email=?").bind(email).first();
      const token = await authNewSession(env, row.id);
      ctx.waitUntil((async () => {
        const cnt = await env.RISK_DB.prepare("SELECT COUNT(*) AS c FROM site_members").first().catch(() => null);
        await slTelegram(env,
          "👤 <b>Trend Insight 신규 회원 가입</b>\n" +
          "이름: " + authEsc(name) + "\n" +
          "이메일: " + authEsc(email) + "\n" +
          "가입 시각: " + authNowKST() + " KST\n" +
          "누적 회원: " + (cnt ? cnt.c : "?") + "명");
      })().catch(() => {}));
      return authJson(200, { ok: true, member: { name, email } },
        { "set-cookie": authSetCookie(token, AUTH_SESSION_DAYS * 86400) });
    }

    if (p === "login" && req.method === "POST") {
      await authEnsureTables(env);
      const b = await req.json().catch(() => ({}));
      const email = String(b.email || "").trim().toLowerCase();
      const pw = String(b.password || "");
      const m = await env.RISK_DB.prepare(
        "SELECT id,name,email,pw_hash,pw_salt,pw_iter,status FROM site_members WHERE email=?").bind(email).first();
      if (!m) return authJson(401, { ok: false, error: "이메일 또는 비밀번호가 올바르지 않습니다" });
      if (m.status !== "active") return authJson(403, { ok: false, error: "이용이 제한된 계정입니다" });
      const hash = await authHashPw(pw, m.pw_salt, m.pw_iter);
      if (hash !== m.pw_hash) return authJson(401, { ok: false, error: "이메일 또는 비밀번호가 올바르지 않습니다" });
      const token = await authNewSession(env, m.id);
      ctx.waitUntil(env.RISK_DB.prepare("UPDATE site_members SET last_login_at=? WHERE id=?")
        .bind(new Date().toISOString(), m.id).run().catch(() => {}));
      return authJson(200, { ok: true, member: { name: m.name, email: m.email } },
        { "set-cookie": authSetCookie(token, AUTH_SESSION_DAYS * 86400) });
    }

    if (p === "logout") {
      const token = authGetToken(req);
      if (token) {
        const th = await rkSha256(token);
        await env.RISK_DB.prepare("DELETE FROM site_sessions WHERE token_hash=?").bind(th).run().catch(() => {});
      }
      const hdr = { "set-cookie": authSetCookie("x", 0) };
      if (req.method === "GET")
        return new Response(null, { status: 302, headers: { ...hdr, location: url.origin + "/login.html" } });
      return authJson(200, { ok: true }, hdr);
    }

    if (p === "members" && req.method === "GET") {
      // 관리자 조회: risk sync와 동일한 Bearer 토큰 사용
      const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const rowT = await env.RISK_DB.prepare("SELECT value FROM meta WHERE key='sync_token_hash'").first();
      if (!rowT || !auth || (await rkSha256(auth)) !== rowT.value)
        return authJson(401, { ok: false, error: "unauthorized" });
      await authEnsureTables(env);
      const rows = await env.RISK_DB.prepare(
        "SELECT id,name,email,status,created_at,last_login_at,agreed_at FROM site_members ORDER BY id DESC").all();
      return authJson(200, { ok: true, count: rows.results.length, members: rows.results });
    }

    if (p === "watchlist-stats" && req.method === "GET") {
      const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const rowT = await env.RISK_DB.prepare("SELECT value FROM meta WHERE key='sync_token_hash'").first();
      if (!rowT || !auth || (await rkSha256(auth)) !== rowT.value)
        return authJson(401, { ok: false, error: "unauthorized" });
      return authJson(200, { ok: true, ...(await authWatchlistStats(env)) });
    }

    if (p === "watchlist-stats/notify" && req.method === "POST") {
      // 집계를 운영자 텔레그램으로 발송 (10분 쿨다운)
      const last = await env.GAUGE_KV.get("wl-stats-notify-at");
      if (last && Date.now() - Number(last) < 600e3)
        return authJson(429, { ok: false, error: "잠시 후 다시 시도해 주세요 (10분 간격)" });
      await env.GAUGE_KV.put("wl-stats-notify-at", String(Date.now()), { expirationTtl: 3600 });
      ctx.waitUntil(authWatchlistTelegram(env, "요청 집계").catch(() => {}));
      return authJson(200, { ok: true });
    }

    return authJson(404, { ok: false, error: "unknown endpoint" });
  } catch (e) {
    return authJson(500, { ok: false, error: String(e) });
  }
}

async function authWatchlistStats(env) {
  await authEnsureTables(env);
  const [members, entries, top] = await Promise.all([
    env.RISK_DB.prepare("SELECT COUNT(*) AS c FROM site_members WHERE status='active'").first(),
    env.RISK_DB.prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT code) AS u, COUNT(DISTINCT member_id) AS m FROM site_watchlist").first(),
    env.RISK_DB.prepare(
      "SELECT code, name, COUNT(*) AS holders FROM site_watchlist GROUP BY code ORDER BY holders DESC, MAX(added_at) DESC LIMIT 20").all(),
  ]);
  return {
    members: members ? members.c : 0,
    registrations: entries ? entries.c : 0,
    unique_stocks: entries ? entries.u : 0,
    members_with_stocks: entries ? entries.m : 0,
    top: top.results,
  };
}

async function authWatchlistTelegram(env, label) {
  const s = await authWatchlistStats(env);
  let msg = "📊 <b>회원 보유종목 집계</b> (" + label + ")\n" +
    "회원 " + s.members + "명 · 종목 등록 " + s.members_with_stocks + "명\n" +
    "등록 " + s.registrations + "건 · 고유 종목 " + s.unique_stocks + "개\n";
  if (s.top.length) {
    msg += "\n<b>상위 종목</b>\n";
    s.top.slice(0, 10).forEach((t, i) => {
      msg += (i + 1) + ". " + authEsc(t.name) + " (" + t.code + ") — " + t.holders + "명\n";
    });
  } else {
    msg += "\n아직 등록된 종목이 없습니다.";
  }
  msg += "\n" + authNowKST() + " KST";
  await slTelegram(env, msg);
}

/* ═══════════════════ PDF 직접 열람 래퍼 ═══════════════════
   iOS Safari 등에서 PDF 파일 주소로 최상위 이동이 일어나면 브라우저 기본 뷰어가 뜨고
   뒤로/홈 버튼이 사라진다. 그런 요청만 골라 HTML 껍데기로 감싼다. */
function isPdfNavigation(req) {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (req.headers.get("accept") || "").includes("text/html");
}

function pdfWrapperPage(url) {
  const file = decodeURIComponent(url.pathname.split("/").pop() || "");
  const name = file.replace(/\.pdf$/i, "");
  const dl = url.pathname + "?dl=1";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(name)} | Trend Insight</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>body{font-family:'Pretendard',sans-serif;margin:0;color:#1c2533;line-height:1.7;background:#f5f7fb}
header{background:#0b1f3f;padding:16px 24px;font-weight:800}header a{color:#fff;text-decoration:none}
main{max-width:1000px;margin:0 auto;padding:20px 14px 40px}
.actions{margin-bottom:14px}.dl{display:inline-block;background:#2e6ff2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:9px;font-weight:700;font-size:.92rem}
.viewer{width:100%;height:85vh;border:1px solid #e4e9f1;border-radius:12px;background:#fff}
.fallback{font-size:.85rem;color:#9aa6b6;margin-top:10px}</style></head>
<body><header style="display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:99988">
<button type="button" class="pn-btn" onclick="(history.length>1&&document.referrer.indexOf(location.origin)===0)?history.back():location.href='/'" style="flex:none;display:inline-flex;background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:6px 13px;font-size:.82rem;font-weight:700;cursor:pointer;font-family:inherit">← 뒤로</button>
<a href="/index.html" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Trend Insight</a>
<a href="/index.html" class="pn-btn" style="flex:none;display:inline-flex;background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:6px 13px;font-size:.82rem;font-weight:700;text-decoration:none">홈</a>
</header><main>
<div class="actions"><a class="dl" href="${esc(dl)}">PDF 다운로드</a></div>
<iframe class="viewer" src="${esc(url.pathname)}?raw=1"></iframe>
<p class="fallback">PDF가 보이지 않으면 위의 'PDF 다운로드' 버튼을 눌러 파일을 직접 여세요.</p>
</main>
<script defer src="/post-nav.js?v=2026080802"></script>
<script defer src="/pdf-viewer.js?v=2026080802"></script>
<script defer src="/site-nav.js?v=2026080802"></script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
