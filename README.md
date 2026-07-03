# BTC 실시간 차트

바이낸스 USDT-M 선물(BTCUSDT) 실시간 차트. 트레이딩 봇의 1h 알림 차트와 동일한 정보 구성을
브라우저에서 실시간으로 본다. 서버 없음 — 바이낸스 공개 REST/WebSocket에 직접 연결하는 정적 사이트.

- 캔들(한국식: 빨강=상승·파랑=하락) + EMA 20/50/200 + VWAP24 + 거래량
- RSI(14, 마감봉) · 펀딩비 · 박스권 오버레이(봇과 동일한 1h winner 파라미터) / 스윙 고·저
- 1시간봉 / 15분봉 토글 (15m은 박스 미표시 — 검증된 전략이 1h 전용)
- 시간축 KST · TradingView Lightweight Charts v4.2.3 (vendored)

## 검증
`verify/compare.py` — 같은 캔들 fixture에 대해 JS 포팅 지표와 봇 파이썬 원본
(notify_extras/ta) 계산을 대조한다. EMA·VWAP·RSI·ATR·박스·스윙 전 항목 일치 확인 후 배포.

정보 제공용이며 투자 권유가 아닙니다.
