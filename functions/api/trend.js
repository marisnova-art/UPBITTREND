// Cloudflare Pages Function — 트렌드 리포트 (실시간 뉴스 · 일간 동향 · 주간 동향). QUANTERA 전용.
// - 뉴스: 국내·해외 코인 뉴스 RSS를 모아 Workers AI(무료 한도)로 한국어 한 줄 요약 + 관련 코인 + 호재/악재를 붙임
// - 일간: 오늘(한국 09시~지금) 업비트 원화 마켓 전체 시세 + 오늘 뉴스 → AI 리포트 (3시간마다 새로)
// - 주간: 거래대금 상위 코인 최근 7일 일봉 + 이번 주 뉴스 → AI 리포트 (하루 한 번 새로)
// 만든 결과는 Supabase q_trend 표에 저장해 두고 같이 봄 (사람마다 만들지 않음 → AI 한도 절약)
// 요청: GET /api/trend?kind=news|daily|weekly   헤더 Authorization: Bearer <supabase access token>
const SB_URL = 'https://owrtvchfcrpiwielyqvo.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93cnR2Y2hmY3JwaXdpZWx5cXZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NzcxODMsImV4cCI6MjEwNTI1MzE4M30.gLS438ACEIb9H_Art1HicRomcZO3CT0ctfpau93fPoc';
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const LIMIT = 10000, N_IN = 26668 / 1e6, N_OUT = 204805 / 1e6;
const NEWS_EVERY = 20 * 60000;          // 뉴스 새로 모으기 간격
const DAILY_EVERY = 3 * 3600000;        // 일간 리포트 새로 만들기 간격
const NEWS_AI_MAX = 12;                 // 한 번에 AI로 요약할 새 뉴스 수
const AI_RESERVE = 0.6;                 // 오늘 사용량이 한도의 60%를 넘으면 뉴스 요약은 건너뜀 (피터 요약·리포트 몫 남김)

const FEEDS = [
  { id: 'blockmedia', name: '블록미디어', lang: 'ko', url: 'https://www.blockmedia.co.kr/feed' },
  { id: 'tokenpost', name: '토큰포스트', lang: 'ko', url: 'https://www.tokenpost.kr/rss' },
  { id: 'coindesk', name: 'CoinDesk', lang: 'en', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'cointelegraph', name: 'Cointelegraph', lang: 'en', url: 'https://cointelegraph.com/rss' },
  { id: 'decrypt', name: 'Decrypt', lang: 'en', url: 'https://decrypt.co/feed' }
];

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const sbHead = auth => ({ apikey: SB_ANON, authorization: auth, 'content-type': 'application/json' });
async function checkUser(request){
  const auth = request.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return null;
  const u = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON, authorization: auth } });
  return u.ok ? auth : null;
}
async function sbGet(auth, query){
  const r = await fetch(`${SB_URL}/rest/v1/q_trend?${query}`, { headers: sbHead(auth) });
  if (!r.ok) throw new Error(r.status === 404 ? 'no_table' : 'db ' + r.status);
  return r.json();
}
async function sbPut(auth, rows){
  if (!rows.length) return;
  await fetch(`${SB_URL}/rest/v1/q_trend?on_conflict=id`, { method: 'POST', headers: { ...sbHead(auth), prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
}
async function usedToday(auth){
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const r = await fetch(`${SB_URL}/rest/v1/q_ai_usage?select=neurons&at=gte.${since.toISOString()}`, { headers: sbHead(auth) });
  if (!r.ok) return 0;
  return (await r.json()).reduce((a, x) => a + (+x.neurons || 0), 0);
}
async function ai(env, auth, tag, system, user, maxTokens){
  const r = await env.AI.run(MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.2 });
  const text = String((r && (r.response || r.result && r.result.response)) || '').trim();
  const us = (r && r.usage) || {};
  const inTok = +us.prompt_tokens || Math.round((system.length + user.length) / 1.6), outTok = +us.completion_tokens || Math.round(text.length / 1.3);
  await fetch(SB_URL + '/rest/v1/q_ai_usage', { method: 'POST', headers: { ...sbHead(auth), prefer: 'return=minimal' },
    body: JSON.stringify({ model: MODEL, market: tag, in_tokens: inTok, out_tokens: outTok, neurons: Math.round((inTok * N_IN + outTok * N_OUT) * 10) / 10 }) }).catch(() => {});
  return text;
}
const kstDay = (t = Date.now()) => new Date(t + 9 * 3600000).toISOString().slice(0, 10);
// 업비트의 하루는 한국 시간 오전 9시(UTC 0시)에 바뀜 → 일간 리포트 날짜는 그 기준
const mktDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const mktStart = (t = Date.now()) => Date.parse(mktDay(t) + 'T00:00:00Z');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- 뉴스
const unx = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&#8230;/g, '…').replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ').trim();
const tag = (x, n) => { const m = x.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i')); return m ? m[1] : ''; };
async function sha(s){ const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)); return [...new Uint8Array(b)].slice(0, 10).map(x => x.toString(16).padStart(2, '0')).join(''); }
async function readFeed(f){
  const res = await fetch(f.url, { headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Mozilla/5.0 (QUANTERA news reader)' }, cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const xml = await res.text();
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return items.slice(0, 25).map(x => {
    const link = unx(tag(x, 'link')) || unx(tag(x, 'guid'));
    const at = Date.parse(unx(tag(x, 'pubDate')) || unx(tag(x, 'dc:date')));
    return { src: f.id, srcName: f.name, lang: f.lang, title: unx(tag(x, 'title')).slice(0, 200), desc: unx(tag(x, 'description')).slice(0, 220), url: link, at: isNaN(at) ? Date.now() : at };
  }).filter(x => x.title && /^https?:\/\//.test(x.url));
}
function parseArr(text){
  const m = text.match(/\[[\s\S]*\]/); if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function refreshNews(env, auth){
  const sources = [], all = [];
  await Promise.all(FEEDS.map(async f => {
    try { const l = await readFeed(f); all.push(...l); sources.push({ id: f.id, name: f.name, ok: true, n: l.length }); }
    catch (e) { sources.push({ id: f.id, name: f.name, ok: false, error: String(e.message || e).slice(0, 60) }); }
  }));
  for (const n of all) n.id = 'n:' + await sha(n.url);
  const since = Date.now() - 3 * 86400000, dup = new Set();
  const fresh = all.filter(n => n.at > since && !dup.has(n.id) && dup.add(n.id));
  // 이미 저장된 것 빼기
  const have = new Set();
  if (fresh.length){
    const ids = fresh.map(n => `"${n.id}"`).join(',');
    for (const r of await sbGet(auth, `select=id&id=in.(${encodeURIComponent(ids)})`)) have.add(r.id);
  }
  const todo = fresh.filter(n => !have.has(n.id)).sort((a, b) => b.at - a.at);
  const canAi = env.AI && (await usedToday(auth)) < LIMIT * AI_RESERVE;
  const batch = canAi ? todo.slice(0, NEWS_AI_MAX) : [];
  let out = [];
  if (batch.length){
    const system = [
      '너는 코인 뉴스 편집자야. 뉴스 목록(번호. 제목 — 요약)을 받아 각각을 한국어로 정리해.',
      '반드시 JSON 배열만 출력해. 다른 말은 쓰지 마. 형식: [{"i":번호,"t":"한국어 제목(40자 안)","s":"한 줄 요약(60자 안)","c":["BTC","ETH"],"m":"+"|"-"|"0"}]',
      'c: 직접 관련된 코인 티커(대문자, 최대 3개, 없으면 []). m: 그 코인·시장에 호재면 "+", 악재면 "-", 중립·판단 어려우면 "0".',
      '제목과 요약에 있는 내용만 써. 추측·과장 금지.'
    ].join('\n');
    const user = batch.map((n, i) => `${i + 1}. ${n.title}${n.desc ? ' — ' + n.desc.slice(0, 160) : ''}`).join('\n');
    try { out = parseArr(await ai(env, auth, 'trend:news', system, user, 1400)); } catch (e) { out = []; }
  }
  const rows = [];
  // AI 요약을 못 붙인 뉴스(한도·실패)는 국내 기사만 원문 제목으로 저장 (영문은 다음 번에 다시 시도)
  for (const n of todo){
    const k = batch.indexOf(n), o = k >= 0 ? out.find(x => +x.i === k + 1) : null;
    if (!o && n.lang !== 'ko') continue;
    const coins = o && Array.isArray(o.c) ? o.c.map(x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean).slice(0, 3) : [];
    rows.push({ id: n.id, kind: 'news', at: new Date(n.at).toISOString(), data: {
      src: n.src, srcName: n.srcName, lang: n.lang, url: n.url, title: n.title,
      t: o && o.t ? String(o.t).slice(0, 80) : n.title, s: o && o.s ? String(o.s).slice(0, 120) : '', c: coins, m: o && ['+', '-', '0'].includes(o.m) ? o.m : '0', ai: !!o } });
  }
  await sbPut(auth, rows);
  await sbPut(auth, [{ id: 'news-meta', kind: 'meta', at: new Date().toISOString(), data: { checkedAt: Date.now(), sources, added: rows.length, waiting: todo.length - rows.length, ai: canAi } }]);
  return { sources, added: rows.length };
}
async function getNews(env, auth, force){
  const meta = (await sbGet(auth, 'select=data&id=eq.news-meta'))[0];
  let info = meta && meta.data;
  if (!info || force || Date.now() - (info.checkedAt || 0) > NEWS_EVERY){
    // 동시에 여러 번 모으지 않도록 먼저 시각을 찍어 둠
    await sbPut(auth, [{ id: 'news-meta', kind: 'meta', at: new Date().toISOString(), data: { ...(info || {}), checkedAt: Date.now() } }]);
    try { const r = await refreshNews(env, auth); info = { ...(info || {}), ...r, checkedAt: Date.now() }; } catch (e) { info = { ...(info || {}), error: String(e.message || e).slice(0, 80) }; }
  }
  const items = await sbGet(auth, 'select=id,at,data&kind=eq.news&order=at.desc&limit=120');
  return { items: items.map(r => ({ id: r.id, at: r.at, ...r.data })), sources: info && info.sources || [], checkedAt: info && info.checkedAt };
}

// ---------------------------------------------------------------- 업비트 시세
async function upbit(path){
  const r = await fetch('https://api.upbit.com/v1/' + path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('upbit ' + r.status);
  return r.json();
}
async function marketSnapshot(){
  const mk = (await upbit('market/all?is_details=false')).filter(x => x.market.startsWith('KRW-'));
  const names = Object.fromEntries(mk.map(x => [x.market, x.korean_name]));
  const tk = [];
  for (let i = 0; i < mk.length; i += 100){ tk.push(...await upbit('ticker?markets=' + mk.slice(i, i + 100).map(x => x.market).join(','))); }
  return { names, tk };
}
const pct = v => Math.round(v * 10000) / 100;
const coinRow = (t, names) => ({ m: t.market, n: names[t.market] || t.market.slice(4), p: t.trade_price, c: pct(t.signed_change_rate), v: Math.round(t.acc_trade_price) });

async function buildDaily(env, auth, newsItems){
  const { names, tk } = await marketSnapshot();
  const up = tk.filter(t => t.signed_change_rate > 0).length, dn = tk.filter(t => t.signed_change_rate < 0).length;
  const total = tk.reduce((a, t) => a + t.acc_trade_price, 0);
  const byC = tk.slice().sort((a, b) => b.signed_change_rate - a.signed_change_rate);
  const byV = tk.slice().sort((a, b) => b.acc_trade_price - a.acc_trade_price);
  const pick = m => { const t = tk.find(x => x.market === m); return t ? coinRow(t, names) : null; };
  const stats = {
    n: tk.length, up, dn, flat: tk.length - up - dn, avg: pct(tk.reduce((a, t) => a + t.signed_change_rate, 0) / (tk.length || 1)),
    total: Math.round(total), btc: pick('KRW-BTC'), eth: pick('KRW-ETH'),
    gainers: byC.slice(0, 6).map(t => coinRow(t, names)), losers: byC.slice(-6).reverse().map(t => coinRow(t, names)),
    volume: byV.slice(0, 6).map(t => ({ ...coinRow(t, names), share: pct(t.acc_trade_price / (total || 1)) }))
  };
  const since = mktStart();
  const news = newsItems.filter(n => Date.parse(n.at) >= since - 6 * 3600000).slice(0, 14);
  const lines = [
    `기준: ${mktDay()} 오전 9시(한국 시간) ~ 지금, 업비트 원화 마켓 ${stats.n}개`,
    `오른 코인 ${up}개 · 내린 코인 ${dn}개 · 평균 등락 ${stats.avg}%`,
    `원화 마켓 오늘 거래대금 합계 약 ${Math.round(total / 1e8).toLocaleString()}억원`,
    stats.btc ? `비트코인 ${stats.btc.p.toLocaleString()}원 (${stats.btc.c}%)` : '', stats.eth ? `이더리움 ${stats.eth.p.toLocaleString()}원 (${stats.eth.c}%)` : '',
    '많이 오른 코인: ' + stats.gainers.map(x => `${x.n} ${x.c}%`).join(', '),
    '많이 내린 코인: ' + stats.losers.map(x => `${x.n} ${x.c}%`).join(', '),
    '거래대금 쏠림: ' + stats.volume.map(x => `${x.n} ${x.share}% (${x.c}%)`).join(', '),
    news.length ? '오늘 뉴스:\n' + news.map(n => `- [${n.m === '+' ? '호재' : n.m === '-' ? '악재' : '중립'}] ${n.t}${n.c && n.c.length ? ' (' + n.c.join(',') + ')' : ''}`).join('\n') : '오늘 뉴스: 없음'
  ].filter(Boolean).join('\n');
  const text = await reportAi(env, auth, 'trend:daily', '오늘(일간) 코인 시장 동향', lines);
  return { stats, text, news: news.slice(0, 6).map(n => n.id), updatedAt: Date.now() };
}

async function buildWeekly(env, auth, newsItems){
  const { names, tk } = await marketSnapshot();
  const top = tk.slice().sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h).slice(0, 24).map(t => t.market);
  for (const m of ['KRW-BTC', 'KRW-ETH']) if (!top.includes(m)) top.push(m);
  const rows = [];
  for (const m of top){
    try {
      const c = await upbit(`candles/days?market=${m}&count=15`);   // 최신이 앞
      if (c.length < 8) continue;
      const now = c[0].trade_price, wk = c[7].trade_price;
      const v1 = c.slice(0, 7).reduce((a, x) => a + x.candle_acc_trade_price, 0), v0 = c.slice(7, 14).reduce((a, x) => a + x.candle_acc_trade_price, 0);
      const hi = Math.max(...c.slice(0, 7).map(x => x.high_price)), lo = Math.min(...c.slice(0, 7).map(x => x.low_price));
      rows.push({ m, n: names[m] || m.slice(4), p: now, c: pct(now / wk - 1), v: Math.round(v1), vc: v0 ? pct(v1 / v0 - 1) : null, range: pct(hi / lo - 1) });
    } catch (e) {}
    await sleep(110);
  }
  const by = rows.slice().sort((a, b) => b.c - a.c);
  const stats = {
    n: rows.length, up: rows.filter(r => r.c > 0).length, dn: rows.filter(r => r.c < 0).length,
    btc: rows.find(r => r.m === 'KRW-BTC') || null, eth: rows.find(r => r.m === 'KRW-ETH') || null,
    gainers: by.slice(0, 6), losers: by.slice(-6).reverse(),
    hot: rows.filter(r => r.vc != null).sort((a, b) => b.vc - a.vc).slice(0, 6)
  };
  const since = Date.now() - 7 * 86400000;
  const news = newsItems.filter(n => Date.parse(n.at) >= since && n.m !== '0').slice(0, 16);
  const lines = [
    `기준: 최근 7일 (${kstDay(since)} ~ ${kstDay()}), 업비트 거래대금 상위 ${rows.length}개 코인`,
    `7일 동안 오른 코인 ${stats.up}개 · 내린 코인 ${stats.dn}개`,
    stats.btc ? `비트코인 7일 ${stats.btc.c}% · 거래대금 지난주 대비 ${stats.btc.vc}%` : '', stats.eth ? `이더리움 7일 ${stats.eth.c}%` : '',
    '7일 상승 상위: ' + stats.gainers.map(x => `${x.n} ${x.c}%`).join(', '),
    '7일 하락 상위: ' + stats.losers.map(x => `${x.n} ${x.c}%`).join(', '),
    '거래대금이 지난주보다 크게 는 코인: ' + stats.hot.map(x => `${x.n} +${x.vc}%`).join(', '),
    news.length ? '이번 주 주요 뉴스:\n' + news.map(n => `- [${n.m === '+' ? '호재' : '악재'}] ${n.t}${n.c && n.c.length ? ' (' + n.c.join(',') + ')' : ''}`).join('\n') : ''
  ].filter(Boolean).join('\n');
  const text = await reportAi(env, auth, 'trend:weekly', '이번 주(주간) 코인 시장 동향', lines);
  return { stats, text, news: news.slice(0, 8).map(n => n.id), updatedAt: Date.now() };
}

async function reportAi(env, auth, tag, title, facts){
  if (!env.AI) return '';
  if ((await usedToday(auth)) > LIMIT * 0.92) return '';
  const system = [
    `너는 QUANTERA의 분석가 "피터"야. 받은 숫자와 뉴스만으로 ${title} 리포트를 한국어로 써.`,
    '형식(꼭 지켜): 아래 5개 소제목을 "■ "로 시작하는 줄로 쓰고, 각 소제목 아래 1~3문장.',
    '■ 한 줄 요약 / ■ 시장 분위기 / ■ 눈에 띈 코인 / ■ 뉴스 흐름 / ■ 체크할 점',
    '규칙: 받은 자료에 없는 숫자·사실·전망을 지어내지 마. 매수·매도를 권하거나 수익을 약속하지 마. 친근한 존댓말(~요). 전문 용어는 쉬운 말로.'
  ].join('\n');
  try { return await ai(env, auth, tag, system, facts, 700); } catch (e) { return ''; }
}

async function getReport(env, auth, kind, force){
  const day = kind === 'daily' ? mktDay() : kstDay(), id = `${kind}-${day}`;
  const list = await sbGet(auth, `select=id,at,data&kind=eq.${kind}&order=at.desc&limit=${kind === 'daily' ? 7 : 4}`);
  const cur = list.find(r => r.id === id);
  const stale = !cur || force || (kind === 'daily' ? Date.now() - (cur.data.updatedAt || 0) > DAILY_EVERY : false);
  if (stale && (!cur || !cur.data.building || Date.now() - cur.data.building > 120000)){
    if (cur) await sbPut(auth, [{ id, kind, at: cur.at, data: { ...cur.data, building: Date.now() } }]);
    const news = (await sbGet(auth, 'select=id,at,data&kind=eq.news&order=at.desc&limit=150')).map(r => ({ id: r.id, at: r.at, ...r.data }));
    const data = kind === 'daily' ? await buildDaily(env, auth, news) : await buildWeekly(env, auth, news);
    if (!data.text && cur && cur.data.text) data.text = cur.data.text;   // AI 한도면 지난 글 유지
    const row = { id, kind, at: new Date().toISOString(), data };
    await sbPut(auth, [row]);
    const rest = list.filter(r => r.id !== id);
    return [row, ...rest];
  }
  return list;
}

export async function onRequestGet({ request, env }) {
  const auth = await checkUser(request);
  if (!auth) return json({ error: 'login', message: '로그인하면 트렌드 리포트를 볼 수 있어요.' }, 401);
  const url = new URL(request.url), kind = url.searchParams.get('kind') || 'news', force = url.searchParams.get('force') === '1';
  try {
    if (kind === 'news') return json(await getNews(env, auth, force));
    if (kind === 'daily' || kind === 'weekly'){
      const rows = await getReport(env, auth, kind, force);
      return json({ reports: rows.map(r => ({ id: r.id, day: r.id.slice(kind.length + 1), at: r.at, ...r.data })) });
    }
    return json({ error: 'bad' }, 400);
  } catch (e) {
    const m = String(e && e.message || e);
    if (m === 'no_table') return json({ error: 'no_table', message: 'Supabase에 q_trend 표가 아직 없어요. phase6-trend.sql을 실행해 주세요.' }, 503);
    return json({ error: 'fail', message: '트렌드를 불러오지 못했어요: ' + m.slice(0, 120) }, 502);
  }
}
