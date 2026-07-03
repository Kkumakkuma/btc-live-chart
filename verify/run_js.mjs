// JS 지표 모듈을 fixture 캔들에 적용해 결과 JSON 출력 (compare.py가 파이썬 원본과 대조)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ema, rsi, vwapRolling, wilderAtrAt, computeBoxOverlay, computeSwing } from "../js/indicators.js";

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, "fixture_1h.json"), "utf-8"));
const bars = rows.map((k) => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
const closes = bars.map((b) => b.close);
const highs = bars.map((b) => b.high);
const lows = bars.map((b) => b.low);
const vols = bars.map((b) => b.volume);
const m = bars.length;

const out = {
  n: m,
  ema20_last: ema(closes, 20)[m - 1],
  ema50_last: ema(closes, 50)[m - 1],
  ema200_last: ema(closes, 200)[m - 1],
  vwap_last: vwapRolling(highs, lows, closes, vols, 24)[m - 1],
  rsi_last_closed: rsi(closes.slice(0, -1), 14).at(-1),
  atr_last_closed: wilderAtrAt(highs, lows, closes, m - 2, 14),
  box: computeBoxOverlay(bars, "1h"),
  swing: computeSwing(bars, 20),
};
console.log(JSON.stringify(out));
