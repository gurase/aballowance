require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const STATE_FILE = path.join(__dirname, 'kids.json');
const DATA_DIR = path.join(__dirname, 'actual-data');
const PORT = parseInt(process.env.PORT || '3000', 10);

const KIDS_GROUP_NAME = 'Kids Allowance';

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { kids: [] };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const kid of s.kids || []) {
      if (!kid.history) kid.history = [];
      // Migrate: replace transaction-based chore completion with a date stamp
      for (const chore of kid.chores || []) {
        if (chore.completedDate === undefined) {
          const wasCompleted =
            (Array.isArray(chore.completedTransactionIds) && chore.completedTransactionIds.length > 0) ||
            (typeof chore.completedTransactionIds === 'string' && chore.completedTransactionIds) ||
            chore.completedTransactionId;
          if (wasCompleted) {
            const entry = kid.history.find(h => h.choreId === chore.id);
            chore.completedDate = entry?.isoDate || new Date().toISOString().slice(0, 10);
          } else {
            chore.completedDate = null;
          }
          delete chore.completedTransactionIds;
          delete chore.completedTransactionId;
        }
      }
    }
    return s;
  } catch { return { kids: [] }; }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Actual Budget API ────────────────────────────────────────────────────────

let actual = null;
let actualReady = false;

async function ensureActual() {
  if (actualReady) return actual;
  const { ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_BUDGET_ID } = process.env;
  if (!ACTUAL_SERVER_URL || !ACTUAL_BUDGET_ID) {
    throw new Error('Set ACTUAL_SERVER_URL and ACTUAL_BUDGET_ID in .env');
  }
  actual = require('@actual-app/api');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  await actual.init({ dataDir: DATA_DIR, serverURL: ACTUAL_SERVER_URL, password: ACTUAL_PASSWORD || '' });
  await actual.downloadBudget(ACTUAL_BUDGET_ID, { password: process.env.ACTUAL_FILE_PASSWORD });
  actualReady = true;
  return actual;
}

const toCents = d => Math.round(parseFloat(d) * 100);
const fromCents = c => c / 100;

async function getActualTransactionsForCategory(categoryId) {
  const a = await ensureActual();
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString().slice(0, 10);
  const { data } = await a.runQuery(
    a.q('transactions')
      .filter({ category: categoryId, date: { $gte: sinceIso } })
      .select(['id', 'date', 'amount', 'imported_payee', 'notes'])
  );
  return (data || [])
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(tx => ({
      id: `actual-${tx.id}`,
      desc: tx.imported_payee || tx.notes || 'Transaction',
      date: fmtHistoryDate(tx.date),
      isoDate: tx.date,
      amount: fromCents(tx.amount),
      type: 'actual',
    }));
}

async function ensureKidsGroup() {
  const a = await ensureActual();
  const groups = await a.getCategoryGroups();
  const existing = groups.find(g => g.name === KIDS_GROUP_NAME && !g.is_income);
  if (existing) return existing.id;
  const id = await a.createCategoryGroup({ name: KIDS_GROUP_NAME });
  await a.sync();
  return id;
}

async function getCategoryBalances() {
  const a = await ensureActual();
  const month = new Date().toISOString().slice(0, 7);
  const budget = await a.getBudgetMonth(month);
  const balances = {};
  for (const cat of budget.categoryGroups?.flatMap(g => g.categories) ?? []) {
    balances[cat.id] = cat.balance;
  }
  return balances;
}

// Move money between two Actual Budget categories by adjusting their budgeted amounts.
// Pass null for fromId or toId to do a one-sided adjustment (e.g. allowance top-up).
async function moveBudget(fromCategoryId, toCategoryId, amountDollars) {
  const a = await ensureActual();
  const month = new Date().toISOString().slice(0, 7);
  const budget = await a.getBudgetMonth(month);
  const budgeted = {};
  for (const cat of budget.categoryGroups?.flatMap(g => g.categories) ?? []) {
    budgeted[cat.id] = cat.budgeted;
  }

  if (fromCategoryId) {
    const cur = budgeted[fromCategoryId] ?? 0;
    await a.setBudgetAmount(month, fromCategoryId, cur - toCents(amountDollars));
  }
  if (toCategoryId) {
    const cur = budgeted[toCategoryId] ?? 0;
    await a.setBudgetAmount(month, toCategoryId, cur + toCents(amountDollars));
  }
  await a.sync();
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function nextWeekday(dayName, after = new Date()) {
  const target = DAYS.indexOf(dayName);
  if (target === -1) return null;
  const d = new Date(after);
  d.setHours(0, 0, 0, 0);
  let diff = target - d.getDay();
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtHistoryDate(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function computeUpcoming(kid, count = 4) {
  if (kid.paused) return [];
  const result = [];
  let cursor = new Date();
  for (let i = 0; i < count; i++) {
    const d = nextWeekday(kid.weeklyDay, cursor);
    if (!d) break;
    result.push({
      desc: 'Weekly allowance',
      date: fmtDate(d),
      isoDate: d.toISOString().slice(0, 10),
      amount: kid.weeklyAllowance,
    });
    cursor = new Date(d.getTime() + 86400000);
  }
  return result;
}

// ─── Chore reset (every Monday) ───────────────────────────────────────────────

function resetChores() {
  const state = loadState();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString().slice(0, 10);
  if (today.getDay() !== 1) return 0; // only Monday
  if (state.lastChoreResetDate === todayIso) return 0;
  let count = 0;
  for (const kid of state.kids) {
    for (const chore of kid.chores) {
      if (chore.completedDate) { chore.completedDate = null; count++; }
    }
  }
  state.lastChoreResetDate = todayIso;
  saveState(state);
  return count;
}

// ─── Allowance processing ─────────────────────────────────────────────────────

async function processAllowances() {
  const state = loadState();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString().slice(0, 10);
  const todayDay = DAYS[today.getDay()];
  let paid = 0;

  for (const kid of state.kids) {
    if (kid.paused || kid.weeklyDay !== todayDay) continue;
    if (kid.lastAllowanceDate === todayIso) continue;
    try {
      await moveBudget(kid.allowanceSourceCategoryId || null, kid.actualCategoryId, kid.weeklyAllowance);
      kid.lastAllowanceDate = todayIso;
      const allowanceDesc = kid.allowanceSourceCategoryName ? `Weekly allowance (from ${kid.allowanceSourceCategoryName})` : 'Weekly allowance';
      kid.history.unshift({ id: genId(), desc: allowanceDesc, date: fmtHistoryDate(todayIso), isoDate: todayIso, amount: kid.weeklyAllowance, type: 'allowance' });
      paid++;
      console.log(`[allowance] Paid $${kid.weeklyAllowance} to ${kid.name}`);
    } catch (err) {
      console.error(`[allowance] Failed for ${kid.name}:`, err.message);
    }
  }

  if (paid > 0) saveState(state);
  return paid;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/categories', async (req, res) => {
  try {
    const a = await ensureActual();
    const groups = await a.getCategoryGroups();
    const categories = groups
      .filter(g => !g.is_income && !g.hidden)
      .flatMap(g => (g.categories || [])
        .filter(c => !c.hidden)
        .map(c => ({ id: c.id, name: c.name, group: g.name }))
      );
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    await ensureActual();
    res.json({ connected: true, serverURL: process.env.ACTUAL_SERVER_URL });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

app.get('/api/kids', async (req, res) => {
  try {
    const { kids } = loadState();
    const balances = await getCategoryBalances();
    const result = kids.map(kid => {
      const balance = fromCents(balances[kid.actualCategoryId] || 0);
      const upcoming = computeUpcoming(kid);
      return {
        ...kid,
        balance,
        nextAllowance: kid.paused ? 'Paused' : (upcoming[0]?.date ?? '—'),
        upcoming,
        chores: kid.chores.map(c => ({ ...c, done: !!c.completedDate })),
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kids', async (req, res) => {
  try {
    const { name, weeklyAllowance = 5, weeklyDay = 'Friday', color, bg, avatar } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    let categoryId = req.body.categoryId;
    if (!categoryId) {
      const groupId = await ensureKidsGroup();
      const a = await ensureActual();
      categoryId = await a.createCategory({ name: `${name}'s Allowance`, group_id: groupId });
      await a.sync();
    }
    const state = loadState();
    const kid = {
      id: genId(),
      name,
      avatar: avatar || name.slice(0, 2).toUpperCase(),
      color: color || '#534AB7',
      bg: bg || '#EEEDFE',
      actualCategoryId: categoryId,
      weeklyAllowance: parseFloat(weeklyAllowance),
      weeklyDay,
      paused: false,
      lastAllowanceDate: null,
      chores: [],
      goals: [],
      history: [],
    };
    state.kids.push(kid);
    saveState(state);
    const upcoming = computeUpcoming(kid);
    res.json({ ...kid, balance: 0, nextAllowance: upcoming[0]?.date ?? '—', upcoming, chores: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/kids/:id', (req, res) => {
  const state = loadState();
  state.kids = state.kids.filter(k => k.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

app.put('/api/kids/:id/allowance', (req, res) => {
  const state = loadState();
  const kid = state.kids.find(k => k.id === req.params.id);
  if (!kid) return res.status(404).json({ error: 'Not found' });
  const { weeklyAllowance, weeklyDay, allowanceSourceCategoryId, allowanceSourceCategoryName } = req.body;
  if (weeklyAllowance != null) kid.weeklyAllowance = parseFloat(weeklyAllowance);
  if (weeklyDay) kid.weeklyDay = weeklyDay;
  kid.allowanceSourceCategoryId = allowanceSourceCategoryId || null;
  kid.allowanceSourceCategoryName = allowanceSourceCategoryName || null;
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/kids/:id/pause', (req, res) => {
  const state = loadState();
  const kid = state.kids.find(k => k.id === req.params.id);
  if (!kid) return res.status(404).json({ error: 'Not found' });
  kid.paused = true;
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/kids/:id/resume', (req, res) => {
  const state = loadState();
  const kid = state.kids.find(k => k.id === req.params.id);
  if (!kid) return res.status(404).json({ error: 'Not found' });
  kid.paused = false;
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/kids/:id/chores', (req, res) => {
  const state = loadState();
  const kid = state.kids.find(k => k.id === req.params.id);
  if (!kid) return res.status(404).json({ error: 'Not found' });
  const { name, amount, sourceCategoryId, sourceCategoryName } = req.body;
  if (!name || !amount) return res.status(400).json({ error: 'Name and amount required' });
  const chore = { id: genId(), name, amount: parseFloat(amount), sourceCategoryId: sourceCategoryId || null, sourceCategoryName: sourceCategoryName || null, completedDate: null };
  kid.chores.push(chore);
  saveState(state);
  res.json({ ...chore, done: false });
});

app.delete('/api/kids/:id/chores/:choreId', (req, res) => {
  const state = loadState();
  const kid = state.kids.find(k => k.id === req.params.id);
  if (!kid) return res.status(404).json({ error: 'Not found' });
  kid.chores = kid.chores.filter(c => c.id !== req.params.choreId);
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/kids/:id/chores/:choreId/complete', async (req, res) => {
  try {
    const state = loadState();
    const kid = state.kids.find(k => k.id === req.params.id);
    if (!kid) return res.status(404).json({ error: 'Not found' });
    const chore = kid.chores.find(c => c.id === req.params.choreId);
    if (!chore) return res.status(404).json({ error: 'Chore not found' });
    if (chore.completedDate) return res.json({ ok: true });
    await moveBudget(chore.sourceCategoryId, kid.actualCategoryId, chore.amount);
    const todayIso = new Date().toISOString().slice(0, 10);
    chore.completedDate = todayIso;
    const desc = chore.sourceCategoryName ? `${chore.name} (from ${chore.sourceCategoryName})` : chore.name;
    kid.history.unshift({ id: genId(), choreId: chore.id, desc, date: fmtHistoryDate(todayIso), isoDate: todayIso, amount: chore.amount, type: 'chore', sourceCategoryName: chore.sourceCategoryName || null });
    saveState(state);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kids/:id/chores/:choreId/uncomplete', async (req, res) => {
  try {
    const state = loadState();
    const kid = state.kids.find(k => k.id === req.params.id);
    if (!kid) return res.status(404).json({ error: 'Not found' });
    const chore = kid.chores.find(c => c.id === req.params.choreId);
    if (!chore) return res.status(404).json({ error: 'Chore not found' });
    if (!chore.completedDate) return res.json({ ok: true });
    await moveBudget(kid.actualCategoryId, chore.sourceCategoryId, chore.amount);
    chore.completedDate = null;
    kid.history = kid.history.filter(h => h.choreId !== chore.id);
    saveState(state);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kids/:id/adjust', async (req, res) => {
  try {
    const state = loadState();
    const kid = state.kids.find(k => k.id === req.params.id);
    if (!kid) return res.status(404).json({ error: 'Not found' });
    const { amount, reason, direction } = req.body;
    if (!amount) return res.status(400).json({ error: 'Amount required' });
    const delta = parseFloat(amount) * (parseFloat(direction) || 1);
    const type = delta < 0 ? 'deduct' : 'bonus';
    // Positive delta: add to kid's budget with no source. Negative: remove from kid's budget.
    await moveBudget(delta < 0 ? kid.actualCategoryId : null, delta >= 0 ? kid.actualCategoryId : null, Math.abs(delta));
    const todayIso = new Date().toISOString().slice(0, 10);
    kid.history.unshift({ id: genId(), desc: reason || 'Manual adjustment', date: fmtHistoryDate(todayIso), isoDate: todayIso, amount: delta, type });
    saveState(state);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/kids/:id/history', async (req, res) => {
  try {
    const { kids } = loadState();
    const kid = kids.find(k => k.id === req.params.id);
    if (!kid) return res.status(404).json({ error: 'Not found' });
    const local = kid.history || [];
    let history = [...local];
    if (kid.actualCategoryId) {
      try {
        const actualTxs = await getActualTransactionsForCategory(kid.actualCategoryId);
        // Exclude actual txs already represented in local history (same date + amount)
        const localKeys = new Set(local.map(h => `${h.isoDate}|${h.amount}`));
        for (const tx of actualTxs) {
          if (!localKeys.has(`${tx.isoDate}|${tx.amount}`)) history.push(tx);
        }
        history.sort((a, b) => b.isoDate.localeCompare(a.isoDate));
      } catch {}
    }
    res.json({ history, upcoming: computeUpcoming(kid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/process-allowances', async (req, res) => {
  try {
    const paid = await processAllowances();
    res.json({ ok: true, paid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cron ─────────────────────────────────────────────────────────────────────

// Daily at 8:00 AM — reset chores on Monday, then pay allowances
cron.schedule('0 8 * * *', () => {
  const reset = resetChores();
  if (reset > 0) console.log(`[cron] Reset ${reset} chore(s) for the new week`);
  processAllowances().catch(err => console.error('[cron]', err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Allowance server → http://localhost:${PORT}`);
  const reset = resetChores();
  if (reset > 0) console.log(`✓ Reset ${reset} chore(s) for the new week`);
  ensureActual()
    .then(() => { console.log('✓ Connected to Actual Budget'); return processAllowances(); })
    .then(paid => { if (paid > 0) console.log(`✓ Processed ${paid} pending allowance(s)`); })
    .catch(err => console.log('⚠ Actual Budget not connected:', err.message));
});
