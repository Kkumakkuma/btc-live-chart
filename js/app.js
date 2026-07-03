// 실시간 BTC 차트 — 바이낸스 USDT-M 선물(fapi) 공개 데이터 직결.
// 봇(1h 알림 PNG)과 같은 정보 구성: 한국식 캔들 + EMA20/50/200 + VWAP24 + 거래량
// + RSI(마감봉) + 펀딩비 + 박스권(1h winner)/스윙 고저선. 시간축 = KST.
import {
  ema, rsi, vwapRolling, computeBoxOverlay, computeSwing, BOX_PARAMS,
} from "./indicators.js";

const SYMBOL = "BTCUSDT";
const REST = "https://fapi.binance.com";
const WS = "wss://fstream.binance.com/ws";
const SEED_LIMIT = 1000;
const KST_OFFSET = 9 * 3600; // Lightweight Charts는 UTC 기준 표시 → KST로 밀어서 표기

// 색 — 봇 차트(notify_extras)와 동일 팔레트
const C = {
  up: "#d24f45", down: "#1f6fd2",
  ema20: "#f59e0b", ema50: "#2563eb", ema200: "#6b7280",
  vwap: "#0891b2",
  box: "#9333ea", upTrig: "#16a34a", dnTrig: "#dc2626",
  swing: "#111827",
};

const els = {
  price: document.getElementById("price"),
  rsi: document.getElementById("rsi"),
  funding: document.getElementById("funding"),
  box: document.getElementById("boxStatus"),
  conn: document.getElementById("conn"),
  legend: document.getElementById("ohlc"),
  chart: document.getElementById("chart"),
  tfBtns: Array.from(document.querySelectorAll("[data-tf]")),
};

let interval = "1h";
let bars = [];          // {time(KST-shift sec), openMs, open, high, low, close, volume}
let ws = null;
let wsRetry = 0;
let priceLines = [];
let lastPrice = null;
let seedToken = 0;      // TF 전환/재시드 경합 방지

// ── 차트 셋업 ────────────────────────────────────────────────
const chart = LightweightCharts.createChart(els.chart, {
  layout: { background: { color: "#ffffff" }, textColor: "#374151",
            fontFamily: "'Pretendard', -apple-system, sans-serif" },
  grid: { vertLines: { color: "#f1f2f4" }, horzLines: { color: "#f1f2f4" } },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.06, bottom: 0.24 } },
  timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false,
               rightOffset: 4 },
  localization: {
    priceFormatter: (p) => p.toLocaleString("en-US", { maximumFractionDigits: 1 }),
  },
});
const candles = chart.addCandlestickSeries({
  upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down,
  wickUpColor: C.up, wickDownColor: C.down,
  priceFormat: { type: "price", precision: 1, minMove: 0.1 },
});
const volSeries = chart.addHistogramSeries({
  priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false,
  priceLineVisible: false,
});
chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
function mkLine(color, width, style) {
  return chart.addLineSeries({
    color, lineWidth: width, lineStyle: style,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
}
const emaS = {
  20: mkLine(C.ema20, 1, LightweightCharts.LineStyle.Solid),
  50: mkLine(C.ema50, 1, LightweightCharts.LineStyle.Solid),
  200: mkLine(C.ema200, 2, LightweightCharts.LineStyle.Solid),
};
const vwapS = mkLine(C.vwap, 1, LightweightCharts.LineStyle.Dashed);

// ── 데이터 ───────────────────────────────────────────────────
function rowToBar(k) {
  return {
    openMs: k[0],
    time: Math.floor(k[0] / 1000) + KST_OFFSET,
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  };
}

async function fetchSeed(itv) {
  const url = `${REST}/fapi/v1/klines?symbol=${SYMBOL}&interval=${itv}&limit=${SEED_LIMIT}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`klines HTTP ${r.status}`);
  return (await r.json()).map(rowToBar);
}

async function fetchFunding() {
  try {
    const r = await fetch(`${REST}/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1`);
    const d = await r.json();
    if (Array.isArray(d) && d.length) {
      const v = parseFloat(d[d.length - 1].fundingRate) * 100;
      els.funding.textContent = `펀딩 ${v >= 0 ? "+" : ""}${v.toFixed(3)}%/8h`;
      els.funding.className = "pill " + (v >= 0 ? "warm" : "cool");
    }
  } catch { /* 표시만 생략 */ }
}

// ── 지표 갱신 ────────────────────────────────────────────────
function seriesData(values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== null && values[i] !== undefined && !Number.isNaN(values[i])) {
      out.push({ time: bars[i].time, value: values[i] });
    }
  }
  return out;
}

function recomputeAll() {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const vols = bars.map((b) => b.volume);
  for (const span of [20, 50, 200]) {
    const e = ema(closes, span);
    // 워밍업 구간(span-1 이전)은 봇 차트(NaN 미표시)와 동일하게 생략
    emaS[span].setData(seriesData(e.map((v, i) => (i >= span - 1 ? v : null))));
  }
  vwapS.setData(seriesData(vwapRolling(highs, lows, closes, vols, 24)));

  // RSI = 마지막 '마감봉' (진행봉 제외) — PNG 제목과 동일 기준
  const rs = rsi(closes.slice(0, -1), 14);
  const rv = rs[rs.length - 1];
  if (rv !== null && rv !== undefined) {
    els.rsi.textContent = `RSI ${Math.round(rv)}`;
    els.rsi.className = "pill " + (rv >= 70 ? "warm" : rv <= 30 ? "cool" : "");
  }
  updateOverlayLines();
}

function updateOverlayLines() {
  for (const pl of priceLines) candles.removePriceLine(pl);
  priceLines = [];
  const add = (price, color, style, width, title) => {
    priceLines.push(candles.createPriceLine({
      price, color, lineStyle: style, lineWidth: width, title,
      axisLabelVisible: true,
    }));
  };
  const LS = LightweightCharts.LineStyle;
  const box = computeBoxOverlay(bars, interval);
  if (box) {
    add(box.boxHi, C.box, LS.Dashed, 1, "박스 상단");
    add(box.boxLo, C.box, LS.Dashed, 1, "박스 하단");
    add(box.upTrig, C.upTrig, LS.Dotted, 1, "상향 돌파선");
    add(box.dnTrig, C.dnTrig, LS.Dotted, 1, "하향 돌파선");
    els.box.textContent = `📦 박스권 형성 중 · 폭 ${box.rangePct.toFixed(2)}% · 박스 내 위치 ${Math.round(box.posPct)}%`;
    els.box.className = "pill boxon";
  } else {
    const sw = computeSwing(bars, 20);
    if (sw) {
      add(sw.swingHi, C.swing, LS.Dashed, 1, "스윙 고점");
      add(sw.swingLo, C.swing, LS.Dashed, 1, "스윙 저점");
    }
    els.box.textContent = interval === "1h"
      ? "박스권 아님 — 스윙 고·저 표시"
      : "15분봉은 박스 없음(1h 전용) — 스윙 고·저 표시";
    els.box.className = "pill";
  }
}

function setPrice(p, prev) {
  lastPrice = p;
  els.price.textContent = `$${p.toLocaleString("en-US", { maximumFractionDigits: 1 })}`;
  if (prev !== null && prev !== undefined) {
    els.price.className = "price " + (p >= prev ? "up" : "down");
  }
}

// ── 실시간 (WebSocket kline) ─────────────────────────────────
function setConn(state) {
  els.conn.textContent = state === "on" ? "● 실시간" : "○ 재연결 중…";
  els.conn.className = "conn " + (state === "on" ? "on" : "off");
}

function openWs(itv, myToken) {
  if (myToken !== seedToken) return;  // stale 흐름이 현재 소켓을 닫지 못하게 (codex High)
  if (ws) { try { ws.onclose = null; ws.close(); } catch { /* noop */ } }
  ws = new WebSocket(`${WS}/${SYMBOL.toLowerCase()}@kline_${itv}`);
  const mySocket = ws;
  ws.onopen = () => {
    if (myToken !== seedToken || ws !== mySocket) { try { mySocket.close(); } catch { /* noop */ } return; }
    wsRetry = 0; setConn("on");
  };
  ws.onmessage = (ev) => {
    if (myToken !== seedToken) return;
    const k = JSON.parse(ev.data).k;
    if (!k) return;
    const bar = {
      openMs: k.t,
      time: Math.floor(k.t / 1000) + KST_OFFSET,
      open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
    };
    const lastIdx = bars.length - 1;
    const prevClose = lastIdx > 0 ? bars[lastIdx - 1].close : null;
    if (bars.length && bar.openMs === bars[lastIdx].openMs) {
      bars[lastIdx] = bar;               // 진행봉 갱신
    } else if (!bars.length || bar.openMs > bars[lastIdx].openMs) {
      bars.push(bar);                    // 새 봉 시작
      bars = bars.slice(-SEED_LIMIT);
    } else {
      return;                            // 과거 메시지 무시
    }
    candles.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    volSeries.update({ time: bar.time, value: bar.volume,
                       color: bar.close >= bar.open ? C.up + "99" : C.down + "99" });
    setPrice(bar.close, prevClose);
    // 진행봉 지표 라이브 갱신(마지막 점만) — EMA 점화식/VWAP 창 재계산
    liveTouchIndicators(bar);
    if (k.x) {
      // 봉 마감 → 전체 재계산(박스/RSI 포함) + 시리즈를 bars와 정확히 동기화
      // (update만 하면 잘려나간 과거 포인트가 시리즈에 계속 쌓임 — codex Low)
      candles.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
      volSeries.setData(bars.map((b) => ({ time: b.time, value: b.volume,
        color: b.close >= b.open ? C.up + "99" : C.down + "99" })));
      recomputeAll();
    }
  };
  ws.onclose = () => {
    if (myToken !== seedToken) return;
    setConn("off");
    const delay = Math.min(15000, 1000 * 2 ** wsRetry++);
    setTimeout(async () => {
      if (myToken !== seedToken) return;
      try { await reseed(myToken); } catch { /* 다음 재시도 */ }
      if (myToken !== seedToken) return;  // await 사이 TF 전환됐으면 중단 (codex High)
      openWs(itv, myToken);
    }, delay);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

function liveTouchIndicators(liveBar) {
  const n = bars.length;
  if (n < 2) return;
  const prevIdx = n - 2;
  const closes = bars.map((b) => b.close);
  for (const span of [20, 50, 200]) {
    if (n <= span) continue;
    // 이전 마감봉까지의 EMA를 한 번만 구해 점화식으로 라이브 점 산출
    const ePrev = ema(closes.slice(0, prevIdx + 1), span)[prevIdx];
    const alpha = 2 / (span + 1);
    emaS[span].update({ time: liveBar.time, value: alpha * liveBar.close + (1 - alpha) * ePrev });
  }
  if (n >= 24) {
    const win = bars.slice(n - 24);
    let tpv = 0; let vol = 0;
    for (const b of win) { tpv += ((b.high + b.low + b.close) / 3) * b.volume; vol += b.volume; }
    if (vol > 0) vwapS.update({ time: liveBar.time, value: tpv / vol });
  }
}

// ── 시드/전환 ────────────────────────────────────────────────
async function reseed(myToken) {
  const fresh = await fetchSeed(interval);
  if (myToken !== seedToken) return;
  bars = fresh;
  candles.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  volSeries.setData(bars.map((b) => ({ time: b.time, value: b.volume,
    color: b.close >= b.open ? C.up + "99" : C.down + "99" })));
  recomputeAll();
  const last = bars[bars.length - 1];
  setPrice(last.close, bars.length > 1 ? bars[bars.length - 2].close : null);
}

async function switchTf(itv) {
  interval = itv;
  seedToken += 1;
  const myToken = seedToken;
  els.tfBtns.forEach((b) => {
    const on = b.dataset.tf === itv;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  setConn("off");
  try {
    await reseed(myToken);
    if (myToken !== seedToken) return;  // await 사이 다른 전환이 시작됐으면 중단 (codex High)
    chart.timeScale().scrollToRealTime();
  } catch (e) {
    if (myToken !== seedToken) return;
    els.box.textContent = "데이터 로딩 실패 — 잠시 후 자동 재시도";
    setTimeout(() => { if (myToken === seedToken) switchTf(itv); }, 5000);
    return;
  }
  openWs(itv, myToken);
}

// ── 크로스헤어 OHLC 레전드 ───────────────────────────────────
chart.subscribeCrosshairMove((param) => {
  const d = param?.seriesData?.get(candles);
  if (!d) { els.legend.textContent = ""; return; }
  const chg = ((d.close - d.open) / d.open) * 100;
  els.legend.innerHTML =
    `시 ${fmt(d.open)} · 고 ${fmt(d.high)} · 저 ${fmt(d.low)} · 종 ${fmt(d.close)} ` +
    `<span class="${chg >= 0 ? "up" : "down"}">(${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)</span>`;
});
function fmt(v) { return v.toLocaleString("en-US", { maximumFractionDigits: 1 }); }

// ── 시작 ─────────────────────────────────────────────────────
els.tfBtns.forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.tf !== interval) switchTf(b.dataset.tf);
}));
window.addEventListener("resize", () => {
  chart.applyOptions({ width: els.chart.clientWidth, height: els.chart.clientHeight });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // 토큰을 올려 전체 재초기화 — 백그라운드 공백을 REST로 메우고 WS도 새로 연다.
    // (WS 유지한 채 같은 토큰으로 덮어쓰면 라이브 봉이 옛 스냅샷으로 역행 가능 — codex Medium)
    switchTf(interval);
  }
});
switchTf("1h");
fetchFunding();
setInterval(fetchFunding, 5 * 60 * 1000);
