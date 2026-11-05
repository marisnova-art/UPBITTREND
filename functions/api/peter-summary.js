// Cloudflare Pages Function — 피터 써머리 (종목 위키 AI 요약). QUANTERA 전용.
// Workers AI(무료 하루 한도 안)를 씀. 로그인한 사용자만 부를 수 있게 Supabase 토큰을 확인합니다.
// 요청: POST /api/peter-summary  { name, market, facts: [문장...] }  헤더 Authorization: Bearer <supabase access token>
const SB_URL = 'https://owrtvchfcrpiwielyqvo.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93cnR2Y2hmY3JwaXdpZWx5cXZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NzcxODMsImV4cCI6MjEwNTI1MzE4M30.gLS438ACEIb9H_Art1HicRomcZO3CT0ctfpau93fPoc';
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: 'no_ai', message: 'AI 연결이 아직 준비되지 않았어요.' }, 503);
  const auth = request.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return json({ error: 'login', message: '로그인하면 쓸 수 있어요.' }, 401);
  const u = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON, authorization: auth } });
  if (!u.ok) return json({ error: 'login', message: '로그인이 만료됐어요. 다시 로그인해 주세요.' }, 401);
  let body; try { body = await request.json(); } catch { return json({ error: 'bad' }, 400); }
  const facts = (Array.isArray(body.facts) ? body.facts : []).map(x => String(x).slice(0, 300)).slice(0, 40);
  if (!facts.length) return json({ error: 'bad' }, 400);
  const name = String(body.name || '').slice(0, 40), market = String(body.market || '').slice(0, 20);
  const system = [
    '너는 QUANTERA의 분석가 "피터"야. 업비트 코인 한 종목에 대한 숫자 자료를 받아서, 사용자가 다음 매매를 판단하기 쉽게 한국어로 요약해.',
    '규칙: 받은 자료에 있는 숫자만 써. 없는 사실·뉴스·전망을 지어내지 마. 수익을 약속하거나 "반드시" 같은 말을 쓰지 마.',
    '형식: 4~6문장의 짧은 단락 하나. 1) 지금 상태(추세·신호) 2) 이 코인의 평소 움직임(변동폭) 3) 내 과거 거래에서 잘 된 점·안 된 점 4) 다음에 볼 가격(매수 구간·목표·손절)이 있으면 그 숫자. 마지막에 "참고용"이라는 말은 붙이지 마(화면에 이미 있음).',
    '말투: 친근한 존댓말(~요). 전문 용어는 쉬운 말로.'
  ].join('\n');
  const user = `종목: ${name} (${market})\n자료:\n- ${facts.join('\n- ')}`;
  try {
    const r = await env.AI.run(MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 500, temperature: 0.3 });
    const text = String((r && (r.response || r.result && r.result.response)) || '').trim();
    if (!text) return json({ error: 'empty', message: 'AI가 빈 답을 줬어요. 잠시 뒤 다시 해 주세요.' }, 502);
    return json({ text, model: MODEL, at: Date.now() });
  } catch (e) {
    const m = String(e && e.message || e);
    return json({ error: 'ai', message: /limit|quota|neuron/i.test(m) ? '오늘 무료 AI 사용량을 다 썼어요. 내일 다시 쓸 수 있어요.' : 'AI 요약을 만들지 못했어요: ' + m.slice(0, 120) }, 502);
  }
}
