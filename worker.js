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
  if (!env.DART_KEY) return { status: "NOKEY", message: "DART_KEY 미설정" };
  const qs = new URLSearchParams({ crtfc_key: env.DART_KEY, ...params });
  try {
    const r = await fetch(`${DART_BASE}/${path}?${qs}`, { cf: { cacheTtl: 600 } });
    if (!r.ok) return { status: "HTTP" + r.status, message: "DART HTTP 오류" };
    return await r.json();
  } catch (e) { return { status: "ERR", message: String(e) }; }
}
async function dartUnzipFirst(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0x504b0304) throw new Error("not a zip");
  const method = dv.getUint16(8, true);
  let compsize = dv.getUint32(18, true);
  const namelen = dv.getUint16(26, true);
  const extralen = dv.getUint16(28, true);
  const start = 30 + namelen + extralen;
  if (!compsize) {
    let cd = bytes.length;
    for (let i = start; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) { cd = i; break; }
    }
    compsize = cd - start;
  }
  const comp = bytes.subarray(start, start + compsize);
  if (method === 0) return new TextDecoder("utf-8").decode(comp);
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(comp).body.pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return new TextDecoder("utf-8").decode(out);
}
async function dartCorpMap(env) {
  const cached = await env.GAUGE_KV.get("dart-corpmap");
  if (cached) return JSON.parse(cached);
  if (!env.DART_KEY) return null;
  const r = await fetch(`${DART_BASE}/corpCode.xml?crtfc_key=${env.DART_KEY}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const xml = await dartUnzipFirst(buf);
  const map = {};
  const re = /<list>[\s\S]*?<corp_code>(\d+)<\/corp_code>[\s\S]*?<corp_name>([\s\S]*?)<\/corp_name>[\s\S]*?<stock_code>\s*([0-9A-Za-z]{6})\s*<\/stock_code>/g;
  let m;
  while ((m = re.exec(xml))) map[m[3]] = { corp_code: m[1], corp_name: m[2].trim() };
  await env.GAUGE_KV.put("dart-corpmap", JSON.stringify(map), { expirationTtl: 86400 });
  return map;
}
async function handleForensic(req, url, env) {
  const p = url.pathname.slice("/api/forensic/".length);
  try {
    if (!env.DART_KEY) return FJ({ ok: false, error: "DART_KEY 미설정 — Cloudflare 대시보드(Workers > trend-insight-site > Settings > Variables and Secrets)에서 DART_KEY 시크릿을 추가하세요." });
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
    return FJ({ ok: false, error: "unknown endpoint" }, 404);
  } catch (e) { return FJ({ ok: false, error: String(e) }, 502); }
}


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

    if (url.pathname.startsWith("/api/cockpit/")) {
      return handleCockpit(req, url, ctx);
    }

    if (url.pathname.startsWith("/api/entry/")) {
      return handleEntry(req, url, ctx);
    }

    if (url.pathname.startsWith("/api/forensic/")) {
      return handleForensic(req, url, env);
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

    if (url.pathname === "/data/market-gauge.json") {
      const v = await env.GAUGE_KV.get("market-gauge");
      if (v) return new Response(v, { headers: JSON_HEADERS });
    }

    if (url.pathname.startsWith("/api/reports/")) {
      return handleReports(req, url, env, ctx);
    }

    const assetRes = await env.ASSETS.fetch(req);
    if ((assetRes.headers.get("content-type") || "").includes("text/html")) {
      return new HTMLRewriter().on("head", {
        element(el) {
          el.append(`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "33e842c948b94e4787347cd2487af700"}'></script>`, { html: true });
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

// redeploy trigger: bind DART_KEY secret (forensic route)
