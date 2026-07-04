// 실시간 BTC 차트 — 바이낸스 USDT-M 선물(fapi) 공개 데이터 직결.
// 봇(1h 알림 PNG)과 같은 정보 구성: 한국식 캔들 + EMA20/50/200 + VWAP24 + 거래량
// + RSI(마감봉) + 펀딩비 + 박스권(1h winner)/스윙 고저선. 시간축 = KST.
import {
  ema, rsi, vwapRolling, computeBoxOverlay, computeSwing,
  calcAtrArray, findBoxSignals, BOX_SL_TP_K, tfTrend, trendConsensus,
} from "./indicators.js?v=2"; // indicators.js 수정 시 v 올릴 것 — app.js(신)+indicators(구 캐시) 섞임 방지

const SYMBOL = "BTCUSDT";
const REST = "https://fapi.binance.com";
// 실시간 = REST 3초 폴링. 바이낸스 '선물' 웹소켓(fstream)은 한국 네트워크에서
// 연결만 되고 데이터가 오지 않는 것을 실측(2026-07-04, kline/aggTrade/markPrice 전부 0건,
// 스팟 WS는 정상) — 선물 데이터 일관성(봇 신호와 동일 소스) 유지를 위해 REST 폴링 채택.
const POLL_MS = 3000;
const SEED_LIMIT = 1000;
const KST_OFFSET = 9 * 3600; // Lightweight Charts는 UTC 기준 표시 → KST로 밀어서 표기

// 색 — 봇 차트(notify_extras)와 동일 팔레트
const C = {
  up: "#d24f45", down: "#1f6fd2",
  ema20: "#f59e0b", ema50: "#2563eb", ema200: "#6b7280",
  vwap: "#0891b2",
  // 한국식 통일(2026-07-04 쿠마님 지시): 매수/상향=빨강, 매도/하향=파랑 (캔들과 동일)
  box: "#9333ea", upTrig: "#d24f45", dnTrig: "#1f6fd2",
  swing: "#111827",
};

const els = {
  price: document.getElementById("price"),
  rsi: document.getElementById("rsi"),
  atr: document.getElementById("atr"),
  bias: document.getElementById("bias"),
  posBtn: document.getElementById("posBtn"),
  posPill: document.getElementById("posPill"),
  posPillTxt: document.getElementById("posPillTxt"),
  posX: document.getElementById("posX"),
  posPanel: document.getElementById("posPanel"),
  posEntry: document.getElementById("posEntry"),
  posSave: document.getElementById("posSave"),
  posClear: document.getElementById("posClear"),
  dirBtns: Array.from(document.querySelectorAll(".dirbtn")),
  funding: document.getElementById("funding"),
  box: document.getElementById("boxStatus"),
  conn: document.getElementById("conn"),
  legend: document.getElementById("ohlc"),
  chart: document.getElementById("chart"),
  tfBtns: Array.from(document.querySelectorAll("[data-tf]")),
};

let interval = "1h";
let bars = [];          // {time(KST-shift sec), openMs, open, high, low, close, volume}
const POS_KEY = "btclc_pos";
let myPos = null;       // {dir:"long"|"short", entry, sl, tp} — 이 브라우저(localStorage)에만 저장
try {
  const raw = localStorage.getItem(POS_KEY);
  if (raw) myPos = JSON.parse(raw);
} catch { /* 손상 데이터 무시 */ }
let pollTimer = null;
let pollFail = 0;
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

let fundingState = null; // {rate(%), nextMs}

function renderFunding() {
  if (!fundingState) return;
  const { rate, nextMs } = fundingState;
  let cd = "";
  const remain = nextMs - Date.now();
  if (remain > 0) {
    const h = Math.floor(remain / 3600000);
    const m = Math.floor((remain % 3600000) / 60000);
    cd = ` · 정산 ${h > 0 ? h + "시간 " : ""}${m}분 후`;
  }
  els.funding.textContent = `펀딩 ${rate >= 0 ? "+" : ""}${rate.toFixed(3)}%${cd}`;
  els.funding.className = "pill " + (rate >= 0 ? "warm" : "cool");
}

async function fetchFunding() {
  try {
    // premiumIndex = 최근 펀딩비 + 다음 정산 시각 (공개, CORS 허용 실측)
    const r = await fetch(`${REST}/fapi/v1/premiumIndex?symbol=${SYMBOL}`);
    const d = await r.json();
    if (d && d.lastFundingRate !== undefined) {
      fundingState = { rate: parseFloat(d.lastFundingRate) * 100, nextMs: +d.nextFundingTime };
      renderFunding();
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

function recomputeAll(allClosed = false) {
  // allClosed=true: 봉마감 직후(새 진행봉 도착 전) — 마지막 봉도 마감봉으로 취급.
  // 기본(false): REST 시드/평시 — 마지막 봉은 진행 중이라 마감 지표에서 제외 (codex High 반영)
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

  // RSI = 마지막 '마감봉' — PNG 제목과 동일 기준
  const closed = allClosed ? bars : bars.slice(0, -1);
  const rs = rsi(closed.map((b) => b.close), 14);
  const rv = rs[rs.length - 1];
  if (rv !== null && rv !== undefined) {
    els.rsi.textContent = `RSI ${Math.round(rv)}`;
    els.rsi.className = "pill " + (rv >= 70 ? "warm" : rv <= 30 ? "cool" : "");
  }

  // ATR(마감봉, Wilder 14 — 봇과 동일). 1h에선 winner 청산폭(±3ATR)도 같이 안내.
  const atrArr = calcAtrArray(closed.map((b) => b.high), closed.map((b) => b.low),
                              closed.map((b) => b.close), 14);
  const av = atrArr[atrArr.length - 1];
  if (av) {
    const w = Math.round(av * BOX_SL_TP_K);
    els.atr.textContent = interval === "1h"
      ? `ATR $${Math.round(av).toLocaleString()} · 손절/익절폭 ±$${w.toLocaleString()}(3ATR)`
      : `ATR $${Math.round(av).toLocaleString()}`;
  }

  // 봇 winner 신호 마커. 15m 자체 신호는 백테스트 검증 실패(2026-07-04, 3,456조합
  // 게이트 통과 0 · 최고 조합도 OOS 음수)라 만들지 않는다 — 대신 검증된 1h 신호를
  // 15m 화면의 같은 시각에 표시(비동기, update15mMarkers).
  if (interval === "1h") {
    const sigs = findBoxSignals(closed, interval);
    candles.setMarkers(sigs.map((s) => ({
      time: closed[s.idx].time,
      position: s.dir === 1 ? "belowBar" : "aboveBar",
      color: s.dir === 1 ? C.upTrig : C.dnTrig,
      shape: s.dir === 1 ? "arrowUp" : "arrowDown",
      text: s.dir === 1 ? "매수" : "매도",
    })));
  } else {
    candles.setMarkers([]);  // 1h 마커 잔존 방지 — 비동기 갱신 전 즉시 비움 (codex)
    update15mMarkers(seedToken);
  }

  // 박스/스윙 계산 함수는 '마지막 원소=진행봉' 전제(파이썬 원본과 동일 검증됨).
  // 봉마감 직후엔 마지막 마감봉을 복제해 붙여 같은 전제를 유지한다 — 복제 원소는
  // last(m-2) 인덱스 계산 밖이라 수치에 영향 없음.
  updateOverlayLines(allClosed ? [...bars, bars[bars.length - 1]] : bars);
}

let markerSeq = 0;  // 같은 토큰 내 마커 요청 순서 보장 (늦게 온 옛 응답이 최신을 덮지 않게 — codex)

async function update15mMarkers(myToken) {
  // 15m 화면 화살표 = 1h winner 신호를 그 신호가 확정된 15분봉(해당 1h봉의 마지막 15m봉)에 표시.
  if (interval !== "15m") return;
  const mySeq = ++markerSeq;
  try {
    const r = await fetch(`${REST}/fapi/v1/klines?symbol=${SYMBOL}&interval=1h&limit=1000`);
    if (!r.ok) return;
    const kl = await r.json();
    if (myToken !== seedToken || interval !== "15m" || mySeq !== markerSeq) return;
    const closed1h = kl.slice(0, -1).map((k) => ({
      openMs: k[0], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    const sigs = findBoxSignals(closed1h, "1h");
    const known = new Set(bars.map((b) => b.openMs));
    const markers = [];
    for (const s of sigs) {
      const t15 = closed1h[s.idx].openMs + 45 * 60000; // 1h 신호봉의 마지막 15m봉 open
      if (!known.has(t15)) continue; // 로드된 15m 범위(약 10일) 밖은 생략
      markers.push({
        time: t15 / 1000 + KST_OFFSET,
        position: s.dir === 1 ? "belowBar" : "aboveBar",
        color: s.dir === 1 ? C.upTrig : C.dnTrig,
        shape: s.dir === 1 ? "arrowUp" : "arrowDown",
        text: s.dir === 1 ? "1h 매수" : "1h 매도",
      });
    }
    candles.setMarkers(markers);
  } catch { /* 마커만 생략 */ }
}

function updateOverlayLines(overlayBars) {
  for (const pl of priceLines) candles.removePriceLine(pl);
  priceLines = [];
  const add = (price, color, style, width, title) => {
    priceLines.push(candles.createPriceLine({
      price, color, lineStyle: style, lineWidth: width, title,
      axisLabelVisible: true,
    }));
  };
  const LS = LightweightCharts.LineStyle;
  const box = computeBoxOverlay(overlayBars, interval);
  if (box) {
    add(box.boxHi, C.box, LS.Dashed, 1, "박스 상단");
    add(box.boxLo, C.box, LS.Dashed, 1, "박스 하단");
    add(box.upTrig, C.upTrig, LS.Dotted, 1, "상향 돌파선");
    add(box.dnTrig, C.dnTrig, LS.Dotted, 1, "하향 돌파선");
    els.box.textContent = `📦 박스권 형성 중 · 폭 ${box.rangePct.toFixed(2)}% · 박스 내 위치 ${Math.round(box.posPct)}%`;
    els.box.className = "pill boxon";
  } else {
    const sw = computeSwing(overlayBars, 20);
    if (sw) {
      add(sw.swingHi, C.swing, LS.Dashed, 1, "스윙 고점");
      add(sw.swingLo, C.swing, LS.Dashed, 1, "스윙 저점");
    }
    els.box.textContent = interval === "1h"
      ? "박스권 아님 — 스윙 고·저 표시"
      : "15분봉은 박스 없음(1h 전용) — 스윙 고·저 표시";
    els.box.className = "pill";
  }
  // 내 포지션 진입가 라인(수동 입력). 손절/익절 참고선은 2026-07-04 쿠마님 지시로 제거 —
  // 증거금·레버리지를 모르는 상태의 ±3ATR 선은 오해 소지. 손익률은 상단 필로만.
  if (myPos && myPos.entry > 0) {
    add(myPos.entry, "#111827", LS.SparseDotted, 2, "내 진입가");
  }
}

// ── 롱/숏 우세 (봇 추세 판정과 동일 — 5m/15m/1h 합의, 60초 갱신) ──
const TREND_TF = [["5m", 288], ["15m", 288], ["1h", 240]]; // 봇 _TF_DAYS와 동일 봉 수

async function updateBias() {
  try {
    const results = await Promise.all(TREND_TF.map(async ([itv, limit]) => {
      try {
        const r = await fetch(`${REST}/fapi/v1/klines?symbol=${SYMBOL}&interval=${itv}&limit=${limit}`);
        if (!r.ok) return null;
        const kl = await r.json();
        return tfTrend(kl.map((k) => ({ open: +k[1], close: +k[4] })));
      } catch {
        return null;  // 한 TF 실패해도 나머지 둘로 합의(2개 미만이면 '판정 불가') — codex
      }
    }));
    const con = trendConsensus(results);
    // 한국식 색: 롱=빨강, 숏=파랑 (차트 캔들과 동일 — 2026-07-04 쿠마님 지시)
    const emo = { "strong-long": "🔴🔴🔴", long: "🔴🔴", mixed: "⚪", short: "🔵🔵",
                  "strong-short": "🔵🔵🔵", na: "⚪" }[con.key];
    els.bias.textContent = `추세 ${emo} ${con.label}`;
    els.bias.className = "pill " + (con.key.includes("long") ? "warm"
      : con.key.includes("short") ? "cool" : "");
    const ko = { LONG: "롱", SHORT: "숏", MIXED: "혼조" };
    els.bias.title = TREND_TF.map(([itv], i) => results[i]
      ? `${itv} ${ko[results[i].trend]}(${results[i].votes}/4표)` : `${itv} 데이터 없음`)
      .join(" · ") + " — 봇과 동일한 4표 투표(EMA5/20·MACD·RSI·양봉), 마감봉 기준";
  } catch { /* 표시만 유지 */ }
}
function renderPosPill() {
  if (!myPos || !(myPos.entry > 0)) {
    els.posPill.hidden = true;
    return;
  }
  const dirTxt = myPos.dir === "short" ? "숏" : "롱";
  let pnlTxt = "";
  if (lastPrice) {
    const pnl = ((lastPrice - myPos.entry) / myPos.entry) * 100 * (myPos.dir === "short" ? -1 : 1);
    pnlTxt = ` · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
    els.posPill.className = "pill " + (pnl >= 0 ? "warm" : "cool");
  } else {
    els.posPill.className = "pill";
  }
  els.posPillTxt.textContent = `내 포지션 ${dirTxt} $${myPos.entry.toLocaleString("en-US", { maximumFractionDigits: 1 })}${pnlTxt}`;
  els.posPill.hidden = false;
}

function clearPos() {
  myPos = null;
  savePosState();
  updateOverlayLines(bars);
  renderPosPill();
  els.posPanel.hidden = true;
  els.posBtn.setAttribute("aria-expanded", "false");
}

function savePosState() {
  try {
    if (myPos) localStorage.setItem(POS_KEY, JSON.stringify(myPos));
    else localStorage.removeItem(POS_KEY);
  } catch { /* 프라이빗 모드 등 — 표시 자체는 동작 */ }
}

function initPosUi() {
  let dir = (myPos && myPos.dir) || "long";
  const syncDirBtns = () => els.dirBtns.forEach((b) => {
    const on = b.dataset.dir === dir;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  syncDirBtns();
  els.posBtn.addEventListener("click", () => {
    const open = els.posPanel.hidden;
    els.posPanel.hidden = !open;
    els.posBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && myPos) els.posEntry.value = myPos.entry;
  });
  els.dirBtns.forEach((b) => b.addEventListener("click", () => { dir = b.dataset.dir; syncDirBtns(); }));
  els.posSave.addEventListener("click", () => {
    const entry = parseFloat(els.posEntry.value);
    if (!(entry > 0)) {
      els.posEntry.focus();
      return;
    }
    myPos = { dir, entry };
    savePosState();
    updateOverlayLines(bars);
    renderPosPill();
    els.posPanel.hidden = true;
    els.posBtn.setAttribute("aria-expanded", "false");
  });
  els.posClear.addEventListener("click", clearPos);
  els.posX.addEventListener("click", clearPos);   // 필의 ✕로 바로 지우기 (쿠마님 요청)
}

function setPrice(p, prev) {
  lastPrice = p;
  els.price.textContent = `$${p.toLocaleString("en-US", { maximumFractionDigits: 1 })}`;
  if (prev !== null && prev !== undefined) {
    els.price.className = "price " + (p >= prev ? "up" : "down");
  }
  renderPosPill();
}

// ── 실시간 (REST 3초 폴링) ───────────────────────────────────
function setConn(state) {
  els.conn.textContent = state === "on" ? "● 실시간" : "○ 연결 재시도 중…";
  els.conn.className = "conn " + (state === "on" ? "on" : "off");
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function applyLatest(latest) {
  // latest = 최근 2봉 [직전 마감봉, 진행봉]. 봉 전환 감지 시 시리즈 전체 동기화+마감 재계산.
  let closedNew = false;
  for (const bar of latest) {
    const lastIdx = bars.length - 1;
    if (bars.length && bar.openMs === bars[lastIdx].openMs) {
      bars[lastIdx] = bar;               // 진행봉(또는 방금 확정된 마지막 봉) 갱신
      candles.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      volSeries.update({ time: bar.time, value: bar.volume,
                         color: bar.close >= bar.open ? C.up + "99" : C.down + "99" });
    } else if (!bars.length || bar.openMs > bars[lastIdx].openMs) {
      bars.push(bar);                    // 새 봉 시작 (직전 봉은 위 분기에서 최종치 반영됨)
      bars = bars.slice(-SEED_LIMIT);
      closedNew = true;
    } else {
      // latest[0]이 이미 지난 봉인 경우 — 데이터만 갱신.
      // (Lightweight Charts의 series.update는 마지막 봉보다 오래된 시각이면 예외 —
      //  시각 반영은 다음 봉 전환 시 setData 동기화로 충분)
      const i = bars.length - 2;
      if (i >= 0 && bars[i].openMs === bar.openMs) {
        bars[i] = bar;
      }
    }
  }
  const last = bars[bars.length - 1];
  setPrice(last.close, bars.length > 1 ? bars[bars.length - 2].close : null);
  if (closedNew) {
    // 봉 전환 → 시리즈를 bars와 정확히 동기화(잘린 과거 포인트 정리) + 마감 지표 재계산
    candles.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    volSeries.setData(bars.map((b) => ({ time: b.time, value: b.volume,
      color: b.close >= b.open ? C.up + "99" : C.down + "99" })));
    recomputeAll();   // 새 진행봉이 이미 존재 → 기본 경로(마지막 봉 제외)가 정확
  } else {
    liveTouchIndicators(last);
  }
}

const IV_MS = { "1h": 3600_000, "15m": 900_000 };

function startPolling(itv, myToken) {
  stopPolling();
  let myTimer = null;   // 세대별 타이머 — stale 콜백이 새 폴링을 끄지 않게 (codex)
  let inFlight = false; // 요청 겹침 방지 — 늦게 온 옛 응답이 최신 봉을 덮지 않게 (codex)
  const tick = async () => {
    if (myToken !== seedToken) {
      if (myTimer) clearInterval(myTimer);
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await fetch(`${REST}/fapi/v1/klines?symbol=${SYMBOL}&interval=${itv}&limit=2`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      if (myToken !== seedToken) return;
      if (Array.isArray(rows) && rows.length) {
        const nb = rows.map(rowToBar);
        const lastOur = bars.length ? bars[bars.length - 1].openMs : 0;
        if (lastOur && nb[nb.length - 1].openMs - lastOur > (IV_MS[itv] || 0)) {
          await reseed(myToken);   // 절전/네트워크 공백으로 봉을 건너뜀 → 전체 재시드 (codex)
        } else {
          applyLatest(nb);
        }
        pollFail = 0;
        setConn("on");
      }
    } catch (e) {
      console.warn("[poll] 갱신 실패:", e);
      pollFail += 1;
      if (pollFail >= 3) setConn("off");  // 일시 오류는 조용히 재시도, 연속 실패만 표시
    } finally {
      inFlight = false;
    }
  };
  tick();
  myTimer = setInterval(tick, POLL_MS);
  pollTimer = myTimer;
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
    candles.setMarkers([]);  // 시드 실패 시 이전 TF 마커 잔존 방지 (codex Low)
    els.box.textContent = "데이터 로딩 실패 — 잠시 후 자동 재시도";
    setTimeout(() => { if (myToken === seedToken) switchTf(itv); }, 5000);
    return;
  }
  startPolling(itv, myToken);
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
initPosUi();
renderPosPill();
switchTf("1h");
fetchFunding();
updateBias();
setInterval(fetchFunding, 5 * 60 * 1000);
setInterval(updateBias, 60 * 1000);
setInterval(renderFunding, 30 * 1000);  // 카운트다운 표시 갱신(재조회 없음)
