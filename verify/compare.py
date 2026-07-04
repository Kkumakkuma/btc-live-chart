# -*- coding: utf-8 -*-
"""JS 포팅 지표 ↔ 봇 파이썬 원본 대조 검증.
fixture_1h.json(바이낸스 fapi 1h 캔들)에 대해 run_js.mjs 결과와
선물봇 notify_extras/ta 계산을 비교한다. 전부 허용오차 내면 통과.
실행: python compare.py  (실시간차트/verify 에서)
"""
import json
import os
import subprocess
import sys

for _s in (sys.stdout, sys.stderr):  # Windows 콘솔(cp949) 이모지 방어
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
BOT = r"C:\Users\goopy\Desktop\Claude\비트코인 선물거래 클로드"
sys.path.insert(0, BOT)
sys.path.insert(0, os.path.join(BOT, "live"))

import pandas as pd
import ta
import notify_extras as ne

with open(os.path.join(HERE, "fixture_1h.json"), encoding="utf-8") as f:
    rows = json.load(f)

js = json.loads(subprocess.run(
    ["node", os.path.join(HERE, "run_js.mjs")],
    capture_output=True, text=True, check=True).stdout)

df = pd.DataFrame({
    "open": [float(k[1]) for k in rows],
    "high": [float(k[2]) for k in rows],
    "low": [float(k[3]) for k in rows],
    "close": [float(k[4]) for k in rows],
    "volume": [float(k[5]) for k in rows],
})
m = len(df)
assert js["n"] == m, f"캔들 수 불일치 {js['n']} != {m}"


def rel_ok(a, b, tol):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= tol * max(1.0, abs(b))


fails = []


def check(name, jsv, pyv, tol=1e-6):
    if not rel_ok(jsv, pyv, tol):
        fails.append(f"{name}: js={jsv} py={pyv}")
    else:
        print(f"  {name}: OK (js={jsv:.6f} / py={pyv:.6f})" if isinstance(pyv, float)
              else f"  {name}: OK")


# EMA (ta.ema_indicator = ewm(span, adjust=False), 워밍업 이후 값)
for span in (20, 50, 200):
    pyv = float(ta.trend.ema_indicator(df["close"], span).iloc[-1])
    check(f"EMA{span}", js[f"ema{span}_last"], pyv)

# VWAP24 (notify_extras 공식)
tp = (df["high"] + df["low"] + df["close"]) / 3
vwap = (tp * df["volume"]).rolling(24).sum() / df["volume"].rolling(24).sum()
check("VWAP24", js["vwap_last"], float(vwap.iloc[-1]))

# RSI(14) 마지막 마감봉 (PNG 제목 기준 iloc[-2])
pyrsi = float(ta.momentum.rsi(df["close"], 14).iloc[-2])
check("RSI(마감봉)", js["rsi_last_closed"], pyrsi)

# Wilder ATR @ 마지막 마감봉 (notify_extras._wilder_atr)
pyatr = ne._wilder_atr(df["high"].tolist(), df["low"].tolist(), df["close"].tolist(), m - 2, 14)
check("ATR(마감봉)", js["atr_last_closed"], float(pyatr), tol=1e-9)

# 박스권 오버레이 (notify_extras._compute_box_overlay, winner 파라미터)
plot_df = df.rename(columns={"open": "Open", "high": "High", "low": "Low",
                             "close": "Close", "volume": "Volume"})
pybox = ne._compute_box_overlay(plot_df, "1h")
if (js["box"] is None) != (pybox is None):
    fails.append(f"box 유무 불일치: js={js['box']} py={pybox}")
elif pybox is not None:
    for jk, pk in (("boxHi", "box_hi"), ("boxLo", "box_lo"), ("upTrig", "up_trig"),
                   ("dnTrig", "dn_trig"), ("rangePct", "range_pct"), ("posPct", "pos_pct")):
        check(f"box.{jk}", js["box"][jk], float(pybox[pk]), tol=1e-9)
else:
    print("  box: 둘 다 None (박스권 아님) OK")

# 스윙 고/저 (진행봉 제외 20봉)
sw_hi = float(plot_df["High"].iloc[-21:-1].max())
sw_lo = float(plot_df["Low"].iloc[-21:-1].min())
check("swing.hi", js["swing"]["swingHi"], sw_hi, tol=1e-12)
check("swing.lo", js["swing"]["swingLo"], sw_lo, tol=1e-12)

# 신호 스윕 = 백테스트 find_signals(winner) 완전 일치 (마커 기능)
import numpy as np  # noqa: E402
import box_breakout_trade_backtest as bt  # noqa: E402
_h = df["high"].to_numpy(); _l = df["low"].to_numpy()
_c = df["close"].to_numpy(); _v = df["volume"].to_numpy()
pysigs = bt.find_signals(_h, _l, _c, _v, bt.calc_atr(_h, _l, _c, 14),
                         bt.calc_ema(_c, 20), bt.calc_ema(_c, 50),
                         24, 2.5, 1.5, 1.0, 1, True)
pysigs = [[int(i), int(d)] for i, d in pysigs]
if js["signals"] != pysigs:
    fails.append(f"signals 불일치: js={js['signals']} py={pysigs}")
else:
    print(f"  signals(find_signals winner): OK ({len(pysigs)}건 완전 일치 — {pysigs})")

if fails:
    print("\n❌ 불일치:")
    for x in fails:
        print("  " + x)
    sys.exit(1)
print("\n✅ JS 포팅 = 파이썬 봇 계산 전 항목 일치")
