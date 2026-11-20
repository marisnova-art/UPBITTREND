// QUANTERA 설정. 분석 기준값은 기존 업비트트랜드와 같은 값을 씁니다.
export const CONFIG = {
  appName: 'QUANTERA',
  api: { base: 'https://api.upbit.com/v1', proxyBase: '/api/upbit', mode: 'auto', minGapMs: 130, maxGapMs: 1600, timeoutMs: 10000, retries: 4 },
  ws: { url: 'wss://api.upbit.com/websocket/v1', reconnectMs: 3000 },
  candles: { daily: 400, weekly: 104, monthly: 60 }, // 일봉 400개: 바닥 반등(1년 고점) 판단과 검증용
  minBars: { daily: 130, weekly: 40, monthly: 12 },
  location: { perAtrAbove: 22, minForEntryZone: 60 },
  overheat: { extendedP: 6.5, statusP: 5 },
  pick: { minTradeValue: 1e9, minRR: 1.2, minWeekRange: 18, count: 5 },
  // 기존 UPBITTREND Supabase 프로젝트(공개 anon 키). 새 테이블은 q_ 접두사로 따로 둡니다.
  supabase: {
    url: 'https://owrtvchfcrpiwielyqvo.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93cnR2Y2hmY3JwaXdpZWx5cXZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NzcxODMsImV4cCI6MjEwNTI1MzE4M30.gLS438ACEIb9H_Art1HicRomcZO3CT0ctfpau93fPoc'
  },
  // 차트 시간 단위 → 업비트 캔들 경로
  timeframes: [
    { id: '1m', label: '1분', path: 'minutes/1' },
    { id: '5m', label: '5분', path: 'minutes/5' },
    { id: '15m', label: '15분', path: 'minutes/15' },
    { id: '1h', label: '1시간', path: 'minutes/60' },
    { id: '1d', label: '일', path: 'days' },
    { id: '1w', label: '주', path: 'weeks' },
    { id: '1M', label: '월', path: 'months' },
    { id: '1y', label: '년', path: 'months' }   // 연봉은 월봉을 합쳐서 만듦
  ]
};
