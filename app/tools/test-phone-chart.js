// QUANTERA 폰 차트 회귀 테스트 — "폰에서 종목 누르면 차트가 안 보임"이 다시 생기지 않게 막는 자동 검사.
// 실행: node app/tools/test-phone-chart.js   (저장소 루트에서, playwright 필요)
// 업비트·Supabase는 가짜 응답으로 대신하므로 키나 인터넷 없이 돌아갑니다.
// 폰 4종(iPhone 13 / iPhone SE / Galaxy S9+ / Pixel 7)마다 확인:
//   1) 마지막에 '분석' 탭을 보고 있었어도 종목을 누르면 차트·호가 탭으로 열린다
//   2) 차트 칸 높이가 충분하고(150px 이상) 봉이 실제로 그려진다
//   3) 다른 종목으로 바꿔도 차트가 다시 그려진다
//   4) 캔들 요청이 실패하면 '차트를 불러오지 못했어요 · 다시 시도'가 뜨고, 다시 시도하면 그려진다
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8139;
const DEVICES = ['iPhone 13', 'iPhone SE', 'Galaxy S9+', 'Pixel 7'];
const MK = { 'KRW-BTC': ['비트코인', 100000000], 'KRW-ETH': ['이더리움', 4000000], 'KRW-XRP': ['리플', 900], 'KRW-SOL': ['솔라나', 200000] };

// Supabase 가짜(로그인 안 한 상태)
const FAKE_SB = `(function(){
  function Q(){ const q = {}; for (const m of ['select','order','limit','range','eq','neq','not','in','gte','lte','gt','lt','is','insert','upsert','update','delete','match','filter','or','contains']) q[m] = () => q;
    q.single = q.maybeSingle = () => q; q.then = (a, b) => Promise.resolve({ data: [], error: null }).then(a, b); return q; }
  const client = { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; }, signOut: async () => ({}), getUser: async () => ({ data: { user: null } }) },
    from: () => Q(), rpc: async () => ({ data: null, error: null }), channel(){ const c = { on(){ return c; }, subscribe(){ return c; }, unsubscribe(){} }; return c; }, removeChannel(){} };
  window.supabase = { createClient: () => client };
})();`;

function candles(m, n){
  const out = []; let p = MK[m] ? MK[m][1] : 1000; const now = Date.now();
  for (let i = 0; i < n; i++){
    const t = new Date(now - i * 864e5); p *= 1 + (Math.sin(i) * 0.01);
    out.push({ market: m, candle_date_time_utc: t.toISOString().slice(0, 19), candle_date_time_kst: t.toISOString().slice(0, 19), opening_price: p, high_price: p * 1.01, low_price: p * 0.99, trade_price: p * 1.002, timestamp: +t, candle_acc_trade_price: 1e9, candle_acc_trade_volume: 10, prev_closing_price: p });
  }
  return out;
}

function serve(){
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }).listen(PORT);
}

async function route(ctx, st){
  await ctx.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('/api/')) return r.fulfill({ json: { items: [] } });
    if (u.startsWith(`http://localhost:${PORT}`)) return r.continue();
    if (u.includes('supabase-js')) return r.fulfill({ body: FAKE_SB, contentType: 'application/javascript' });
    if (u.includes('market/all')) return r.fulfill({ json: Object.entries(MK).map(([m, [k]]) => ({ market: m, korean_name: k, english_name: m })) });
    if (u.includes('candles')){
      if (st.failCandles) return r.fulfill({ status: 400, json: { error: 'test' } });
      const m = new URL(u).searchParams.get('market') || 'KRW-BTC'; st.candleReq++;
      return r.fulfill({ json: candles(m, 200) });
    }
    if (u.includes('ticker')) return r.fulfill({ json: Object.entries(MK).map(([m, [, p]]) => ({ market: m, trade_price: p, signed_change_rate: 0.01, change_rate: 0.01, acc_trade_price_24h: 1e11, prev_closing_price: p * 0.99, opening_price: p, high_price: p * 1.01, low_price: p * 0.98, acc_trade_price: 1e10, timestamp: Date.now() })) });
    if (u.includes('orderbook')) return r.fulfill({ json: [{ market: 'KRW-BTC', orderbook_units: Array.from({ length: 15 }, (_, i) => ({ ask_price: 100100000 + i * 1000, bid_price: 100000000 - i * 1000, ask_size: 1, bid_size: 1 })) }] });
    if (u.includes('trades')) return r.fulfill({ json: [] });
    return r.abort();   // 외부 CDN 등은 막음 → 차트 프로그램이 우리 사이트 안에서 오는지도 함께 확인
  });
}

const chartState = pg => pg.evaluate(() => {
  const w = document.querySelector('#chartWrap'), r = w.getBoundingClientRect();
  const err = w.querySelector('.chart-err');
  const tv = document.querySelector('#tv').getBoundingClientRect();
  const cv = [...w.querySelectorAll('.tv-lightweight-charts canvas, #tv canvas')].reduce((m, c) => Math.max(m, c.getBoundingClientRect().height), 0);
  return { cp: document.querySelector('#mApp').dataset.cp, h: Math.round(r.height), w: Math.round(r.width), tvH: Math.round(tv.height), tvW: Math.round(tv.width), cvH: Math.round(cv), bars: +(w.dataset.bars || 0), canvas: w.querySelectorAll('canvas').length, err: !!err, visible: getComputedStyle(document.querySelector('#mCpChart')).display !== 'none' };
});
const waitBars = (pg, ms = 8000) => pg.waitForFunction(() => +(document.querySelector('#chartWrap').dataset.bars || 0) > 0, null, { timeout: ms }).catch(() => {});

(async () => {
  const srv = serve(); const b = await chromium.launch(); const fails = [];
  const check = (dev, name, ok, info) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${dev} · ${name} ${JSON.stringify(info)}`); if (!ok) fails.push(`${dev} · ${name}`); };
  try{
    for (const dev of DEVICES){
      const st = { failCandles: false, candleReq: 0 };
      const ctx = await b.newContext({ ...devices[dev] }); await route(ctx, st);
      await ctx.addInitScript(() => { try{ localStorage.setItem('quantera:mCp', JSON.stringify('insp')); }catch(_){} });   // 지난번에 '분석' 탭을 보던 상태
      const pg = await ctx.newPage(); pg.on('pageerror', e => fails.push(`${dev} · 페이지 오류 ${e.message}`));
      await pg.goto(`http://localhost:${PORT}/app/`);
      await pg.waitForFunction(() => window.LightweightCharts, null, { timeout: 10000 }).catch(() => {});
      await pg.waitForTimeout(2500);

      await pg.evaluate(() => document.querySelector('[data-go="list"][data-tab="all"]').click());
      await pg.waitForSelector('#mList [data-mm]', { timeout: 8000 });
      await pg.evaluate(() => document.querySelectorAll('#mList [data-mm]')[0].click());
      await waitBars(pg);
      let s = await chartState(pg);
      check(dev, '종목 누르면 차트 탭', s.cp === 'chart' && s.visible, s);
      check(dev, '차트 높이·봉', s.h >= 150 && s.w >= 250 && s.tvH >= 150 && s.tvW >= 250 && s.cvH >= 100 && s.bars > 50 && s.canvas > 0 && !s.err, s);

      await pg.evaluate(() => history.back()); await pg.waitForTimeout(500);
      await pg.evaluate(() => document.querySelectorAll('#mList [data-mm]')[1].click());
      await pg.waitForTimeout(300); await waitBars(pg);
      s = await chartState(pg);
      check(dev, '두 번째 종목 차트', s.cp === 'chart' && s.h >= 150 && s.bars > 50, s);

      st.failCandles = true;
      await pg.evaluate(() => history.back()); await pg.waitForTimeout(500);
      await pg.evaluate(() => document.querySelectorAll('#mList [data-mm]')[2].click());
      await pg.waitForSelector('#chartWrap .chart-err', { timeout: 15000 }).catch(() => {});
      s = await chartState(pg);
      check(dev, '실패 시 다시 시도 버튼', s.err && s.bars === 0, s);
      st.failCandles = false;
      await pg.evaluate(() => document.querySelector('#chartWrap [data-chretry]') && document.querySelector('#chartWrap [data-chretry]').click());
      await waitBars(pg);
      s = await chartState(pg);
      check(dev, '다시 시도 후 차트', !s.err && s.bars > 50, s);
      await ctx.close();
    }
  } finally { await b.close(); srv.close(); }
  if (fails.length){ console.log('\n실패 ' + fails.length + '건:\n- ' + fails.join('\n- ')); process.exit(1); }
  console.log('\n모두 통과');
})();
