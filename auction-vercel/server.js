const express = require('express');
const { createClient } = require('@libsql/client');
const ExcelJS = require('exceljs');
const path = require('path');

const PW = process.env.TEACHER_PW || 'tyc6036';
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:' + path.join(__dirname, 'market.db'), // 本機測試用檔案；雲端用 Turso
  authToken: process.env.TURSO_AUTH_TOKEN
});
const X = ex => async (sql, a = []) => {
  const rs = await ex.execute({ sql, args: a });
  return rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
};
const all = X(db);
const get = async (s, a) => (await all(s, a))[0];
const run = (s, a = []) => db.execute({ sql: s, args: a });

const ready = db.batch([
  `create table if not exists markets(name text primary key, duration int default 4, floor real, cap real, status text default 'setup', started_at int, ends_at int, round int default 1)`,
  `create table if not exists slots(id integer primary key autoincrement, market text, role text, value real, cash real, nick text)`,
  `create table if not exists orders(id integer primary key autoincrement, market text, round int, slot int, side text, price real, status text default 'open', ts int)`,
  `create table if not exists trades(id integer primary key autoincrement, market text, round int, seq int, buyer int, seller int, price real, ts int)`,
  `create table if not exists snapshots(market text primary key, json text, ts int)`
], 'write');
ready.catch(() => {});

const now = () => Date.now();
const M = n => get('select * from markets where name=?', [n]);
const slotsOf = n => all('select * from slots where market=? order by id', [n]);

async function tick(m) {
  if (m && m.status === 'running' && now() >= m.ends_at) {
    await run("update markets set status='ended' where name=?", [m.name]);
    m.status = 'ended';
    await buildSnap(m.name);
  }
  return m;
}

// 委託簿與成交快照：存入資料庫，最多每 10 秒重算一次
async function buildSnap(name) {
  const m = await M(name);
  if (!m) return null;
  const trades = await all('select seq,price,ts from trades where market=? and round=? order by seq', [name, m.round]);
  const agg = async (side, ord) => (await all(
    `select price,count(*) q from orders where market=? and round=? and side=? and status='open' group by price order by price ${ord} limit 5`,
    [name, m.round, side])).map(r => [r.price, r.q]);
  const s = { trades, bids: await agg('buy', 'desc'), asks: await agg('sell', 'asc'), ts: now() };
  await run('insert or replace into snapshots values(?,?,?)', [name, JSON.stringify(s), s.ts]);
  return s;
}
async function getSnap(m) {
  const row = await get('select json,ts from snapshots where market=?', [m.name]);
  if (row && (m.status !== 'running' || now() - row.ts < 10000)) return JSON.parse(row.json);
  return buildSnap(m.name);
}

async function results(m) {
  const sl = await slotsOf(m.name);
  const by = Object.fromEntries(sl.map(s => [s.id, s]));
  const tr = await all('select * from trades where market=? and round=?', [m.name, m.round]);
  const demand = sl.filter(s => s.role === 'buy').map(s => s.value).sort((a, b) => b - a);
  const supply = sl.filter(s => s.role === 'sell').map(s => s.value).sort((a, b) => a - b);
  let k = 0, max = 0;
  while (k < Math.min(demand.length, supply.length) && demand[k] >= supply[k]) { max += demand[k] - supply[k]; k++; }
  let cs = 0, ps = 0;
  tr.forEach(t => { cs += by[t.buyer].value - t.price; ps += t.price - by[t.seller].value; });
  return { cs, ps, total: cs + ps, max, eff: max ? (cs + ps) / max * 100 : 0, eqQ: k, qty: tr.length, demand, supply };
}
const tradeOf = (m, id) => get('select * from trades where market=? and round=? and (buyer=? or seller=?)', [m.name, m.round, id, id]);

const app = express();
app.use(express.json());
app.use((q, r, n) => ready.then(() => n(), e => r.status(500).json({ err: '資料庫連線失敗：' + e.message })));
app.use(express.static(path.join(__dirname, 'public')));
const A = f => (q, r) => f(q, r).catch(e => { console.error(e); if (!r.headersSent) r.status(500).json({ err: '伺服器錯誤：' + e.message }); });
const T = (q, r, n) => (q.get('x-pw') || q.query.pw) === PW ? n() : r.status(401).json({ err: '密碼錯誤' });
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;

app.post('/api/teacher/login', (q, r) => r.json(q.body.pw === PW ? { ok: 1 } : { err: '密碼錯誤' }));

app.get('/api/markets', A(async (q, r) => {
  for (const m of await all("select * from markets where status='running'")) await tick(m);
  r.json(await all('select name,status from markets order by rowid desc'));
}));

app.get('/api/teacher/market', T, A(async (q, r) => {
  const m = await tick(await M(q.query.name));
  r.json(m ? { market: m, slots: await slotsOf(m.name) } : { none: 1 });
}));

app.post('/api/teacher/market', T, A(async (q, r) => {
  const { name, duration, floor, cap, buyers = [], sellers = [] } = q.body;
  if (!name || !name.trim()) return r.json({ err: '請輸入班級名稱' });
  let m = await M(name);
  if (!m) await run('insert into markets(name,duration,floor,cap) values(?,?,?,?)', [name, +duration || 4, num(floor), num(cap)]);
  else await run('update markets set duration=?,floor=?,cap=? where name=?', [+duration || 4, num(floor), num(cap), name]);
  m = await M(name);
  if (m.status === 'setup') {
    const old = await slotsOf(name);
    const nicks = { buy: old.filter(s => s.role === 'buy').map(s => s.nick), sell: old.filter(s => s.role === 'sell').map(s => s.nick) };
    const st = [{ sql: 'delete from slots where market=?', args: [name] }];
    const ins = 'insert into slots(market,role,value,cash,nick) values(?,?,?,?,?)';
    buyers.forEach((b, i) => st.push({ sql: ins, args: [name, 'buy', +b.value, +b.cash, nicks.buy[i] || null] }));
    sellers.forEach((s, i) => st.push({ sql: ins, args: [name, 'sell', +s.value, 0, nicks.sell[i] || null] }));
    await db.batch(st, 'write');
  }
  r.json({ ok: 1, locked: m.status !== 'setup' });
}));

app.post('/api/teacher/start', T, A(async (q, r) => {
  const m = await M(q.body.name);
  if (!m) return r.json({ err: '找不到市場' });
  const t = now();
  await run("update markets set status='running',started_at=?,ends_at=? where name=?", [t, t + m.duration * 60000, m.name]);
  await buildSnap(m.name);
  r.json({ ok: 1 });
}));
app.post('/api/teacher/stop', T, A(async (q, r) => {
  await run("update markets set status='ended',ends_at=? where name=?", [now(), q.body.name]);
  await buildSnap(q.body.name);
  r.json({ ok: 1 });
}));
app.post('/api/teacher/reset', T, A(async (q, r) => {
  await run("update markets set status='setup',round=round+1,started_at=null,ends_at=null where name=?", [q.body.name]);
  await buildSnap(q.body.name);
  r.json({ ok: 1 });
}));

app.post('/api/join', A(async (q, r) => {
  const { market, nick } = q.body;
  const m = await M(market);
  if (!m) return r.json({ err: '找不到市場' });
  if (!nick || !nick.trim()) return r.json({ err: '請輸入暱稱' });
  const n = nick.trim().slice(0, 12);
  let s = await get('select * from slots where market=? and nick=?', [market, n]);
  if (!s) {
    const free = await all('select * from slots where market=? and nick is null', [market]);
    if (!free.length) return r.json({ err: '名額已滿' });
    s = free[Math.floor(Math.random() * free.length)];
    // 以條件更新避免兩位學生同時搶到同一個身分
    const u = await run('update slots set nick=? where id=? and nick is null', [n, s.id]);
    if (!u.rowsAffected) return r.json({ err: '請再按一次加入' });
  }
  r.json({ slot: s.id, nick: n });
}));

app.get('/api/state', A(async (q, r) => {
  const m = await tick(await M(q.query.market));
  if (!m) return r.json({ err: '找不到市場' });
  const teacher = q.get('x-pw') === PW;
  const snap = await getSnap(m);
  const out = {
    status: m.status, remaining: m.status === 'running' ? Math.max(0, m.ends_at - now()) : 0,
    duration: m.duration, floor: m.floor, cap: m.cap, round: m.round, ...snap
  };
  if (m.status === 'ended' || teacher) out.results = await results(m);
  if (teacher) {
    const tr = await all('select * from trades where market=? and round=?', [m.name, m.round]);
    out.slots = (await slotsOf(m.name)).map(s => {
      const t = tr.find(x => x.buyer === s.id || x.seller === s.id);
      return { ...s, price: t ? t.price : null };
    });
  } else {
    const s = await get('select * from slots where id=? and market=?', [+q.query.slot || 0, m.name]);
    if (s) {
      const t = await tradeOf(m, s.id);
      const o = await get("select price from orders where market=? and round=? and slot=? and status='open'", [m.name, m.round, s.id]);
      out.me = {
        role: s.role, value: s.value, cash: s.cash, nick: s.nick, done: !!t, price: t ? t.price : null,
        profit: t ? (s.role === 'buy' ? s.value - t.price : t.price - s.value) : null, open: o ? o.price : null
      };
    }
  }
  r.json(out);
}));

app.post('/api/order', A(async (q, r) => {
  const { market, slot, price } = q.body;
  const p = +price;
  const m = await tick(await M(market));
  if (!m || m.status !== 'running') return r.json({ err: '目前不在交易時間' });
  const s = await get('select * from slots where id=? and market=?', [+slot || 0, market]);
  if (!s) return r.json({ err: '身分無效' });
  if (await tradeOf(m, s.id)) return r.json({ err: '你已經成交，不能再出價' });
  if (!(p > 0)) return r.json({ err: '請輸入正確價格' });
  if (m.floor != null && p < m.floor) return r.json({ err: `價格不得低於 ${m.floor}（老師設定下限）` });
  if (m.cap != null && p > m.cap) return r.json({ err: `價格不得高於 ${m.cap}（老師設定上限）` });
  if (s.role === 'buy' && p > s.value) return r.json({ err: `出價不能高於你的最高願付價 ${s.value}` });
  if (s.role === 'buy' && p > s.cash) return r.json({ err: `資金不足（持有 ${s.cash}）` });
  if (s.role === 'sell' && p < s.value) return r.json({ err: `開價不能低於你的成本 ${s.value}` });

  const tx = await db.transaction('write');
  const t = X(tx);
  let traded = null;
  try {
    await t("update orders set status='replaced' where market=? and round=? and slot=? and status='open'", [market, m.round, s.id]);
    const opp = (await t(s.role === 'buy'
      ? "select * from orders where market=? and round=? and side='sell' and status='open' and price<=? order by price asc, ts asc, id asc limit 1"
      : "select * from orders where market=? and round=? and side='buy' and status='open' and price>=? order by price desc, ts asc, id asc limit 1",
      [market, m.round, p]))[0];
    if (opp) {
      const seq = (await t('select count(*) c from trades where market=? and round=?', [market, m.round]))[0].c + 1;
      const [b, se] = s.role === 'buy' ? [s.id, opp.slot] : [opp.slot, s.id];
      await t('insert into trades(market,round,seq,buyer,seller,price,ts) values(?,?,?,?,?,?,?)', [market, m.round, seq, b, se, opp.price, now()]);
      await t("update orders set status='filled' where id=?", [opp.id]);
      await t("insert into orders(market,round,slot,side,price,status,ts) values(?,?,?,?,?,'filled',?)", [market, m.round, s.id, s.role, p, now()]);
      traded = opp.price;
    } else {
      await t('insert into orders(market,round,slot,side,price,ts) values(?,?,?,?,?,?)', [market, m.round, s.id, s.role, p, now()]);
    }
    await tx.commit();
  } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
  r.json({ ok: 1, traded });
}));

app.post('/api/cancel', A(async (q, r) => {
  const m = await M(q.body.market);
  if (m) await run("update orders set status='cancelled' where market=? and round=? and slot=? and status='open'", [m.name, m.round, +q.body.slot || 0]);
  r.json({ ok: 1 });
}));

app.get('/api/export', T, A(async (q, r) => {
  const m = await M(q.query.name);
  if (!m) return r.status(404).send('not found');
  const sl = await slotsOf(m.name), by = Object.fromEntries(sl.map(s => [s.id, s]));
  const nm = id => (by[id] && (by[id].nick || `#${id}`)) || '';
  const tm = ts => new Date(ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  const wb = new ExcelJS.Workbook();
  const w1 = wb.addWorksheet('市場設定');
  w1.addRow(['班級', m.name]); w1.addRow(['交易時間(分)', m.duration]); w1.addRow(['價格下限', m.floor ?? '無']); w1.addRow(['價格上限', m.cap ?? '無']); w1.addRow([]);
  w1.addRow(['身分', '暱稱', '成本/最高願付價', '持有資金']);
  sl.forEach(s => w1.addRow([s.role === 'buy' ? '買家' : '賣家', s.nick || '', s.value, s.role === 'buy' ? s.cash : '']));
  const w2 = wb.addWorksheet('成交紀錄');
  w2.addRow(['回合', '順序', '時間', '買家', '賣家', '成交價', '消費者剩餘', '生產者剩餘']);
  (await all('select * from trades where market=? order by round,seq', [m.name])).forEach(t =>
    w2.addRow([t.round, t.seq, tm(t.ts), nm(t.buyer), nm(t.seller), t.price, by[t.buyer].value - t.price, t.price - by[t.seller].value]));
  const w3 = wb.addWorksheet('出價紀錄');
  w3.addRow(['回合', '時間', '暱稱', '買/賣', '價格', '狀態']);
  const st = { open: '掛單中', filled: '成交', replaced: '已改價', cancelled: '已撤單' };
  (await all('select * from orders where market=? order by id', [m.name])).forEach(o =>
    w3.addRow([o.round, tm(o.ts), nm(o.slot), o.side === 'buy' ? '買' : '賣', o.price, st[o.status]]));
  const rs = await results(m);
  const w4 = wb.addWorksheet('本回合結果');
  [['成交量', rs.qty], ['均衡數量(理論)', rs.eqQ], ['消費者剩餘', rs.cs], ['生產者剩餘', rs.ps], ['市場總剩餘', rs.total], ['理論最大剩餘', rs.max], ['市場效率(%)', +rs.eff.toFixed(1)]]
    .forEach(x => w4.addRow(x));
  r.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  r.setHeader('Content-Disposition', `attachment; filename="market-${encodeURIComponent(m.name)}.xlsx"`);
  await wb.xlsx.write(r);
  r.end();
}));

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`課堂競拍系統已啟動：http://localhost:${port}`));
}
