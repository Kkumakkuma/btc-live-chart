// 지표 계산 — 봇(비트코인 선물거래 클로드) 계산식의 1:1 JS 포팅.
// 대응 원본:
//   EMA   → backtest calc_ema / pandas ewm(span, adjust=False)  (e0=c0, α=2/(span+1))
//   RSI   → ta.momentum.rsi = Wilder ewm(alpha=1/n, adjust=False)
//   VWAP  → notify_extras: rolling 24봉 sum(tp·vol)/sum(vol), tp=(h+l+c)/3
//   ATR   → notify_extras._wilder_atr / calc_atr (TR[0]=high0-low0 포함, Wilder)
//   BOX   → notify_extras._compute_box_overlay + listener winner 파라미터(1h 전용)
//   SWING → notify_extras 스윙 고/저 (진행봉 제외 직전 20봉)
// 검증: verify/compare.py 가 같은 캔들 데이터로 파이썬 원본과 대조한다.

export const BOX_PARAMS = {
  "1h": { lookback: 24, maxRange: 2.5, atrK: 1.0 },
  // 15m 박스는 백테스트 우위 없음(winner는 1h 전용) — 정직하게 미표시
};

export function ema(closes, span) {
  const alpha = 2 / (span + 1);
  const out = new Array(closes.length);
  if (!closes.length) return out;
  out[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    out[i] = alpha * closes[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

export function rsi(closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  // Wilder: 첫 diff부터 ewm(alpha=1/period, adjust=False) — ta.momentum.rsi와 동일 점화식
  let avgGain = null;
  let avgLoss = null;
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    if (avgGain === null) {
      avgGain = gain;
      avgLoss = loss;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (i >= period) {
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function vwapRolling(highs, lows, closes, vols, window = 24) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  const tpv = new Array(n);
  for (let i = 0; i < n; i++) {
    tpv[i] = ((highs[i] + lows[i] + closes[i]) / 3) * vols[i];
  }
  let sumTpv = 0;
  let sumVol = 0;
  for (let i = 0; i < n; i++) {
    sumTpv += tpv[i];
    sumVol += vols[i];
    if (i >= window) {
      sumTpv -= tpv[i - window];
      sumVol -= vols[i - window];
    }
    if (i >= window - 1 && sumVol > 0) {
      out[i] = sumTpv / sumVol;
    }
  }
  return out;
}

export function wilderAtrAt(highs, lows, closes, idx, period = 14) {
  // notify_extras._wilder_atr 그대로: TR[0]=high0-low0 포함, idx까지 Wilder 평활
  if (idx < period - 1) return 0;
  const trs = [highs[0] - lows[0]];
  for (let i = 1; i <= idx; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// 박스권 오버레이 — notify_extras._compute_box_overlay 포팅.
// bars = [{high, low, close}, ...] 전체(마지막 = 진행 중 봉 포함).
// 박스권 '형성 중'일 때만 값 반환, 아니면 null.
export function computeBoxOverlay(bars, interval) {
  const p = BOX_PARAMS[interval];
  if (!p) return null;
  const m = bars.length;
  const last = m - 2; // 진행 중 봉 제외 → 마지막 마감봉
  if (last - p.lookback < 1) return null;
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  let winH = -Infinity;
  let winL = Infinity;
  for (let i = last - p.lookback; i < last; i++) {
    if (highs[i] > winH) winH = highs[i];
    if (lows[i] < winL) winL = lows[i];
  }
  if (winL <= 0 || winH <= winL) return null;
  const rangePct = ((winH - winL) / winL) * 100;
  if (rangePct >= p.maxRange) return null;
  const atrB = wilderAtrAt(highs, lows, closes, last, 14);
  const cur = closes[last];
  return {
    boxHi: winH,
    boxLo: winL,
    upTrig: winH + p.atrK * atrB,
    dnTrig: winL - p.atrK * atrB,
    rangePct,
    cur,
    posPct: ((cur - winL) / (winH - winL)) * 100,
  };
}

// 직전 스윙 고/저 — 진행 중 봉 제외 최근 20봉 (notify_extras iloc[-21:-1] 동일)
export function computeSwing(bars, lookback = 20) {
  const m = bars.length;
  if (m < lookback + 1) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = m - 1 - lookback; i < m - 1; i++) {
    if (bars[i].high > hi) hi = bars[i].high;
    if (bars[i].low < lo) lo = bars[i].low;
  }
  if (!(hi > lo && lo > 0)) return null;
  return { swingHi: hi, swingLo: lo };
}
