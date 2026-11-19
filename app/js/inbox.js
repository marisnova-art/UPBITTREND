// 알림함: 연결 문제 · 업비트 공지 · 매매(매도 예약가·모의 익절/손절) · 내 코인 뉴스 · 급등락을 한 목록에 모아 둠.
// 이 기기에만 저장 (최근 200개 · 7일). key가 같은 알림은 한 번만 쌓임.
import { LS } from './util.js';

const KEY = 'quantera:inbox', MAX = 200, KEEP = 7 * 86400000;
export const INBOX_KINDS = [['all', '전체'], ['conn', '연결'], ['notice', '업비트 공지'], ['trade', '매매'], ['news', '뉴스'], ['market', '급등락']];
export const KIND_KO = Object.fromEntries(INBOX_KINDS);

let items = (LS.get(KEY, []) || []).filter(x => x && x.id && Date.now() - x.at < KEEP);
const subs = new Set();
const save = () => { if (items.length > MAX) items.length = MAX; try { LS.set(KEY, items); } catch(e){} };
const emit = x => { for (const f of subs) try { f(x); } catch(e){ console.error(e); } };

export const inbox = {
  list: (kind = 'all') => kind === 'all' ? items : items.filter(x => x.kind === kind),
  unread: () => items.reduce((n, x) => n + !x.read, 0),
  urgentUnread: () => items.filter(x => !x.read && x.urgent),
  has: key => items.some(x => x.key === key),
  // it: { kind, title, body, urgent, key, m(종목), ip, url, tone }
  add(it){
    if (it.key && items.some(x => x.key === it.key)) return null;
    const x = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), read: false, ...it };
    items.unshift(x); save(); emit(x); return x;
  },
  read(id){ const x = items.find(y => y.id === id); if (x && !x.read){ x.read = true; save(); emit(null); } },
  readAll(){ let ch = false; for (const x of items) if (!x.read){ x.read = true; ch = true; } if (ch){ save(); emit(null); } },
  clear(kind = 'all'){ items = kind === 'all' ? [] : items.filter(x => x.kind !== kind); save(); emit(null); },
  on(f){ subs.add(f); return () => subs.delete(f); },
};
