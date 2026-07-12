// Trend Insight 시장 온도계 — Cloudflare Worker
// cron(매 거래일 13:00·16:00 KST)마다 코스피/코스닥 지표를 계산해 KV에 저장하고,
// /data/market-gauge.json 요청 시 KV 값을 우선 제공한다 (없으면 정적 파일 폴백).
// /api/refresh-gauge 로 수동 즉시 갱신도 가능.

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateGauge(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

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
