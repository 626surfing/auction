const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const PW = process.env.TEACHER_PW; // 只從環境變數讀取，程式碼中不放密碼；未設定時教師功能全部停用
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
  `create table if not exists snapshots(market text primary key, json text, ts int)`,
  `create table if not exists exports(market text, round int, ts int, primary key(market, round))`
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
  const agg = async (side, ord) => (await all(
    `select price,count(*) q from orders where market=? and round=? and side=? and status='open' group by price order by price ${ord} limit 5`,
    [name, m.round, side])).map(r => [r.price, r.q]);
  const [trades, bids, asks] = await Promise.all([
    all('select seq,price,ts from trades where market=? and round=? order by seq', [name, m.round]),
    agg('buy', 'desc'), agg('sell', 'asc')
  ]);
  const s = { trades, bids, asks, ts: now() };
  await run('insert or replace into snapshots values(?,?,?)', [name, JSON.stringify(s), s.ts]);
  return s;
}
async function getSnap(m) {
  const row = await get('select json,ts from snapshots where market=?', [m.name]);
  if (row && (m.status !== 'running' || now() - row.ts < 10000)) return JSON.parse(row.json);
  return buildSnap(m.name);
}

async function results(m) {
  const [sl, tr] = await Promise.all([slotsOf(m.name), all('select * from trades where market=? and round=?', [m.name, m.round])]);
  const by = Object.fromEntries(sl.map(s => [s.id, s]));
  const demand = sl.filter(s => s.role === 'buy').map(s => s.value).sort((a, b) => b - a);
  const supply = sl.filter(s => s.role === 'sell').map(s => s.value).sort((a, b) => a - b);
  let k = 0, max = 0;
  while (k < Math.min(demand.length, supply.length) && demand[k] >= supply[k]) { max += demand[k] - supply[k]; k++; }
  let maxCS = 0, maxPS = 0, pLo = null, pHi = null;
  if (k > 0) {
    pLo = Math.max(supply[k - 1], k < demand.length ? demand[k] : -Infinity);
    pHi = Math.min(demand[k - 1], k < supply.length ? supply[k] : Infinity);
    for (let i = 0; i < k; i++) { maxCS += demand[i] - pLo; maxPS += pHi - supply[i]; }
  }
  let cs = 0, ps = 0;
  const buyL = [], sellL = [];
  const nk = id => by[id].nick || ('#' + id);
  tr.forEach(t => {
    const a = by[t.buyer].value - t.price, b = t.price - by[t.seller].value;
    cs += a; ps += b;
    buyL.push({ id: t.buyer, nick: nk(t.buyer), amt: a });
    sellL.push({ id: t.seller, nick: nk(t.seller), amt: b });
  });
  buyL.sort((x, y) => y.amt - x.amt); sellL.sort((x, y) => y.amt - x.amt);
  const win = l => (l.length && l[0].amt > 0) ? l.filter(x => x.amt === l[0].amt).map(x => x.id) : [];
  return {
    cs, ps, total: cs + ps, max, eff: max ? (cs + ps) / max * 100 : 0, eqQ: k, qty: tr.length, demand, supply, maxCS, maxPS, pLo, pHi,
    topCS: buyL.slice(0, 3), topPS: sellL.slice(0, 3), winIds: [...win(buyL), ...win(sellL)]
  };
}
const tradeOf = (m, id) => get('select * from trades where market=? and round=? and (buyer=? or seller=?)', [m.name, m.round, id, id]);

const app = express();
app.use(express.json());
app.use((q, r, n) => ready.then(() => n(), e => r.status(500).json({ err: '資料庫連線失敗：' + e.message })));
app.use(express.static(path.join(__dirname, 'public')));
const A = f => (q, r) => f(q, r).catch(e => { console.error(e); if (!r.headersSent) r.status(500).json({ err: '伺服器錯誤：' + e.message }); });
const T = (q, r, n) => PW && (q.get('x-pw') || q.query.pw) === PW ? n() : r.status(401).json({ err: '密碼錯誤' });
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;

app.post('/api/teacher/login', (q, r) => r.json(PW && q.body.pw === PW ? { ok: 1 } : { err: '密碼錯誤' }));

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
  const teacher = !!PW && q.get('x-pw') === PW;
  const sid = +q.query.slot || 0;
  const wantRes = m.status === 'ended' || teacher;
  const [snap, rs, tr, sl, mySlot, myTrade, myOpen] = await Promise.all([
    getSnap(m),
    wantRes ? results(m) : null,
    teacher ? all('select * from trades where market=? and round=?', [m.name, m.round]) : null,
    teacher ? slotsOf(m.name) : null,
    !teacher ? get('select * from slots where id=? and market=?', [sid, m.name]) : null,
    !teacher ? tradeOf(m, sid) : null,
    !teacher ? get("select price from orders where market=? and round=? and slot=? and status='open'", [m.name, m.round, sid]) : null
  ]);
  const out = {
    status: m.status, remaining: m.status === 'running' ? Math.max(0, m.ends_at - now()) : 0,
    duration: m.duration, floor: m.floor, cap: m.cap, round: m.round, now: now(), ...snap
  };
  if (rs) out.results = teacher ? rs : { ...rs, topCS: undefined, topPS: undefined, winIds: undefined }; // 前三名暱稱只給教師
  if (teacher) {
    out.slots = sl.map(s => {
      const t = tr.find(x => x.buyer === s.id || x.seller === s.id);
      return { ...s, price: t ? t.price : null };
    });
  } else if (mySlot) {
    const t = myTrade;
    out.me = {
      role: mySlot.role, value: mySlot.value, cash: mySlot.cash, nick: mySlot.nick, best: !!(rs && rs.winIds.includes(mySlot.id)), done: !!t, price: t ? t.price : null,
      profit: t ? (mySlot.role === 'buy' ? mySlot.value - t.price : t.price - mySlot.value) : null, open: myOpen ? myOpen.price : null
    };
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
  if (s.role === 'buy' && p > s.value) return r.json({ err: '不能這樣出價，會虧錢' });
  if (s.role === 'buy' && p > s.cash) return r.json({ err: `資金不足（持有 ${s.cash}）` });
  if (s.role === 'sell' && p < s.value) return r.json({ err: '不能這樣出價，會虧錢' });

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

const COLORS = ['#DBEAFE', '#DCFCE7', '#FEF9C3', '#FCE7F3', '#EDE9FE', '#FFEDD5']; // 各回合輪流使用的底色
const r2 = x => +(+x).toFixed(2);
app.post('/api/teacher/sheets', T, A(async (q, r) => {
  const url = process.env.SHEETS_WEBHOOK_URL, tok = process.env.SHEETS_WEBHOOK_TOKEN;
  if (!url || !tok) return r.json({ err: '尚未設定 Google 試算表連線（環境變數 SHEETS_WEBHOOK_URL、SHEETS_WEBHOOK_TOKEN）' });
  const m = await M(q.body.name);
  if (!m) return r.json({ err: '找不到市場' });
  if (m.status !== 'ended' || !m.started_at) return r.json({ err: '請等本回合交易結束後再匯出' });
  if ((await get('select ts from exports where market=? and round=?', [m.name, m.round])) && !q.body.force) return r.json({ dup: 1 });
  const [sl, trs, rs] = await Promise.all([
    slotsOf(m.name),
    all('select * from trades where market=? and round=? order by seq', [m.name, m.round]),
    results(m)
  ]);
  const by = Object.fromEntries(sl.map(s => [s.id, s]));
  const nm = s => s.nick || ('未加入#' + s.id);
  const ft = ts => new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }).replace(/[\u2009\u202f]/g, ' ');
  const lim = (m.floor != null || m.cap != null) ? `本回合價格限制：下限 ${m.floor ?? '無'}、上限 ${m.cap ?? '無'}（理論值未納入價格限制）。` : '';
  const payload = {
    token: tok,
    sheet: m.name.replace(/[:\\\/?*\[\]]/g, '_').slice(0, 90) || 'market',
    color: COLORS[(m.round - 1) % COLORS.length],
    title: `班級：${m.name}　第 ${m.round} 回合　交易時間：${ft(m.started_at)} ～ ${ft(m.ends_at)}`,
    note: `理論最大消費者剩餘＝價格定在均衡價格區間最低價時的總和；理論最大生產者剩餘＝定在區間最高價時的總和（兩者不會同時發生）。${lim}`,
    summary: [
      ['實際消費者剩餘（總）', r2(rs.cs)], ['實際生產者剩餘（總）', r2(rs.ps)], ['實際總剩餘', r2(rs.total)],
      ['理論最大消費者剩餘（總）', r2(rs.maxCS)], ['理論最大生產者剩餘（總）', r2(rs.maxPS)], ['理論最大總剩餘', r2(rs.max)],
      ['市場效率', `${r2(rs.eff)}%`],
      ['均衡價格區間', rs.pLo == null ? '無' : `${rs.pLo} 至 ${rs.pHi}`],
      ['成交筆數', `成交 ${rs.qty} 筆（理論 ${rs.eqQ} 筆）`]
    ],
    buyers: sl.filter(s => s.role === 'buy').sort((a, b) => b.value - a.value).map(s => [nm(s), s.value]),
    sellers: sl.filter(s => s.role === 'sell').sort((a, b) => a.value - b.value).map(s => [nm(s), s.value]),
    trades: trs.map(t => [t.seq, ft(t.ts), nm(by[t.buyer]), by[t.buyer].value, nm(by[t.seller]), by[t.seller].value, t.price,
      r2(by[t.buyer].value - t.price), r2(t.price - by[t.seller].value)])
  };
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 25000);
  let txt;
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow', signal: ac.signal });
    txt = await resp.text();
  } catch (e) {
    return r.json({ err: '無法連線到 Google 試算表：' + e.message });
  } finally { clearTimeout(to); }
  let res;
  try { res = JSON.parse(txt); } catch { return r.json({ err: '試算表回應異常，請確認 Apps Script 已部署為網頁應用程式，且存取權為「任何人」' }); }
  if (res.err) return r.json({ err: '試算表回報：' + res.err });
  await run('insert or replace into exports values(?,?,?)', [m.name, m.round, now()]);
  r.json({ ok: 1, url: res.url });
}));

app.get('/api/export', T, A(async (q, r) => {
  const ExcelJS = require('exceljs');
  const m = await M(q.query.name);
  if (!m) return r.status(404).send('not found');
  const sl = await slotsOf(m.name), by = Object.fromEntries(sl.map(s => [s.id, s]));
  const nm = id => (by[id] && (by[id].nick || `#${id}`)) || '';
  const tm = ts => ts ? new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }).replace(/[\u2009\u202f]/g, ' ') : '';
  const wb = new ExcelJS.Workbook();
  const w1 = wb.addWorksheet('市場設定');
  w1.addRow(['班級', m.name]); w1.addRow(['交易時間(分)', m.duration]); w1.addRow(['價格下限', m.floor ?? '無']); w1.addRow(['價格上限', m.cap ?? '無']); w1.addRow([]);
  w1.addRow(['身分', '暱稱', '成本/最高願付價', '持有資金']);
  sl.forEach(s => w1.addRow([s.role === 'buy' ? '買家' : '賣家', s.nick || '', s.value, s.role === 'buy' ? s.cash : '']));
  const w2 = wb.addWorksheet('成交紀錄');
  // 每人每回合只有一筆「成交」委託，其時間即為排隊優先順序的依據（同價者先掛單先成交）
  const fts = {};
  (await all("select slot,round,ts from orders where market=? and status='filled'", [m.name])).forEach(o => { fts[o.round + '-' + o.slot] = o.ts; });
  w2.addRow(['回合', '成交順序', '成交時間', '買家暱稱', '賣家暱稱', '成交價格', '買方掛單時間', '賣方掛單時間', '消費者剩餘', '生產者剩餘']);
  (await all('select * from trades where market=? order by round,seq', [m.name])).forEach(t =>
    w2.addRow([t.round, t.seq, tm(t.ts), nm(t.buyer), nm(t.seller), t.price, tm(fts[t.round + '-' + t.buyer]), tm(fts[t.round + '-' + t.seller]),
      by[t.buyer].value - t.price, t.price - by[t.seller].value]));
  for (let i = 1; i <= 10; i++) w2.getColumn(i).width = i === 3 || i === 7 || i === 8 ? 22 : 12;
  const w3 = wb.addWorksheet('出價紀錄');
  w3.addRow(['回合', '時間', '暱稱', '買/賣', '價格', '狀態']);
  const st = { open: '掛單中', filled: '成交', replaced: '已改價', cancelled: '已撤單' };
  (await all('select * from orders where market=? order by id', [m.name])).forEach(o =>
    w3.addRow([o.round, tm(o.ts), nm(o.slot), o.side === 'buy' ? '買' : '賣', o.price, st[o.status]]));
  const rs = await results(m);
  const w4 = wb.addWorksheet('本回合結果');
  [['成交量', rs.qty], ['均衡數量(理論)', rs.eqQ], ['消費者剩餘', rs.cs], ['生產者剩餘', rs.ps], ['市場總剩餘', rs.total], ['理論最大剩餘', rs.max], ['市場效率(%)', +rs.eff.toFixed(1)]]
    .forEach(x => w4.addRow(x));
  w4.addRow([]);
  rs.topCS.forEach((x, i) => w4.addRow([`消費者剩餘第${i + 1}名`, x.nick, x.amt]));
  rs.topPS.forEach((x, i) => w4.addRow([`生產者剩餘第${i + 1}名`, x.nick, x.amt]));
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
