require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const { Resend } = require('resend');
// Stock prices fetched directly via Yahoo Finance HTTP API (no npm package needed)
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');

const app      = express();
const PORT     = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

app.use(cors({
  origin: (origin, cb) => cb(null, true), // allow all origins (public API)
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// ── MongoDB connection ────────────────────────────────────────────────────────
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email:          { type: String, required: true, unique: true, lowercase: true },
  passwordHash:   { type: String, required: true },
  investments:    { type: Array,  default: [] },
  portfolioHistory: { type: Array, default: [] },
  watchlist:      { type: Array,  default: [] },
  createdAt:      { type: Date,   default: Date.now },
});
const User = mongoose.model('User', userSchema);

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    console.warn('⚠ MONGODB_URI not set — user data will not persist across restarts.');
    return false;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✓ MongoDB connected');
    return true;
  } catch (err) {
    console.error('✗ MongoDB connection failed:', err.message);
    return false;
  }
}

// In-memory fallback when MongoDB is unavailable
const memStore = {};
let useDB = false;

async function getUser(email) {
  if (useDB) return await User.findOne({ email: email.toLowerCase() });
  return memStore[email.toLowerCase()] || null;
}

async function upsertUser(email, data) {
  const key = email.toLowerCase();
  if (useDB) {
    return await User.findOneAndUpdate(
      { email: key },
      { $set: data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  memStore[key] = { ...(memStore[key] || {}), ...data, email: key };
  return memStore[key];
}

async function getAllUsers() {
  if (useDB) return await User.find({});
  return Object.values(memStore);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

// ── Stock prices & news ───────────────────────────────────────────────────────

async function fetchNews(ticker) {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=3&enableFuzzyQuery=false`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.news || []).slice(0, 3).map(n => n.title).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchPrices(tickers) {
  const results = {};
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const meta  = data?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error('No data returned');
      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose ?? meta.previousClose ?? price;
      if (!price) throw new Error('No price in response');
      results[ticker] = { price, dayChangePct: prev ? ((price - prev) / prev) * 100 : 0 };
      console.log(`✓ ${ticker}: $${price}`);
    } catch (err) {
      console.error(`✗ fetchPrices ${ticker}: ${err.message}`);
    }
  }));
  return results;
}

// ── Email ─────────────────────────────────────────────────────────────────────

function fmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Email is not configured. Add RESEND_API_KEY to your Render environment variables.');
  }
  return new Resend(process.env.RESEND_API_KEY);
}

async function sendEmail(to, subject, html) {
  const resend = getResend();
  const { error } = await resend.emails.send({
    from: 'Investment Tracker <onboarding@resend.dev>',
    to,
    subject,
    html,
  });
  if (error) throw new Error(error.message);
}

async function sendPortfolioEmail(email, investments) {
  const tickers = investments.map(i => i.ticker);
  const prices  = await fetchPrices(tickers);

  let totalCost = 0, totalValue = 0;
  const alerts = [], rows = [];

  for (const inv of investments) {
    const cost = inv.shares * inv.purchasePrice;
    totalCost += cost;
    const p = prices[inv.ticker];
    if (!p) continue;

    const value   = inv.shares * p.price;
    const gain    = value - cost;
    const gainPct = (gain / cost) * 100;
    totalValue   += value;

    const gainColor = gain >= 0 ? '#4ade80' : '#f87171';
    const dayColor  = p.dayChangePct >= 0 ? '#4ade80' : '#f87171';
    const sign      = gain >= 0 ? '+' : '';
    const daySign   = p.dayChangePct >= 0 ? '+' : '';

    rows.push(`
      <tr style="border-bottom:1px solid #1e2235;">
        <td style="padding:10px 14px;font-weight:700;color:#60a5fa;">${inv.ticker}</td>
        <td style="padding:10px 14px;">${Number(inv.shares).toLocaleString()}</td>
        <td style="padding:10px 14px;">$${fmt(p.price)}</td>
        <td style="padding:10px 14px;">$${fmt(value)}</td>
        <td style="padding:10px 14px;color:${gainColor};">${sign}$${fmt(gain)} (${sign}${gainPct.toFixed(2)}%)</td>
        <td style="padding:10px 14px;color:${dayColor};">${daySign}${p.dayChangePct.toFixed(2)}%</td>
      </tr>`);

    if (Math.abs(p.dayChangePct) >= 5) {
      const dir = p.dayChangePct > 0 ? 'surged' : 'dropped';
      alerts.push({ ticker: inv.ticker, dir, pct: p.dayChangePct });
    }
  }

  // Fetch news headlines for any big movers
  await Promise.all(alerts.map(async a => {
    a.headlines = await fetchNews(a.ticker);
  }));

  const gain    = totalValue - totalCost;
  const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : 0;
  const sign    = gain >= 0 ? '+' : '';
  const gainColor = gain >= 0 ? '#4ade80' : '#f87171';
  const today   = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const alertBlock = alerts.length
    ? `<div style="margin-top:24px;padding:18px 20px;background:#1e2235;border-left:3px solid #facc15;border-radius:8px;font-size:14px;line-height:1.8;">
        <div style="font-weight:700;font-size:15px;margin-bottom:12px;">⚠️ Notable Moves</div>
        ${alerts.map(a => `
          <div style="margin-bottom:14px;">
            <div style="font-weight:700;color:${a.pct > 0 ? '#4ade80' : '#f87171'};">
              ${a.ticker} ${a.dir} ${Math.abs(a.pct).toFixed(1)}% today
            </div>
            ${a.headlines.length
              ? `<div style="margin-top:6px;color:#94a3b8;font-size:13px;">
                  ${a.headlines.map(h => `• ${h}`).join('<br>')}
                </div>`
              : `<div style="color:#5a6380;font-size:12px;margin-top:4px;">No recent headlines found.</div>`
            }
          </div>`).join('')}
       </div>`
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0f1a;font-family:'Segoe UI',system-ui,sans-serif;color:#e2e8f0;">
<div style="max-width:640px;margin:0 auto;padding:32px 16px;">
  <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 4px;">📈 Portfolio Update</h1>
  <p style="color:#5a6380;font-size:13px;margin:0 0 28px;">${today}</p>
  <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;">
    ${[['Total Value',`$${fmt(totalValue)}`,''],['Total Cost',`$${fmt(totalCost)}`,''],
       ['Gain / Loss',`${sign}$${fmt(gain)}`,gainColor],['% Return',`${sign}${gainPct.toFixed(2)}%`,gainColor]]
      .map(([label,val,color])=>`
      <div style="flex:1;min-width:130px;background:#161928;border:1px solid #2a2f4a;border-radius:10px;padding:14px 16px;text-align:center;">
        <div style="font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;">${label}</div>
        <div style="font-size:20px;font-weight:700;${color?`color:${color};`:''}">${val}</div>
      </div>`).join('')}
  </div>
  <table width="100%" cellpadding="0" cellspacing="0"
    style="background:#161928;border:1px solid #2a2f4a;border-radius:10px;font-size:13px;border-collapse:collapse;">
    <thead><tr style="background:#1e2235;">
      ${['Ticker','Shares','Price','Value','Gain / Loss','Today']
        .map(h=>`<th style="padding:10px 14px;text-align:left;font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;">${h}</th>`).join('')}
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  ${alertBlock}
  <p style="margin-top:28px;font-size:11px;color:#5a6380;text-align:center;">
    Investment Tracker · Daily at 8:00 AM ET on weekdays
  </p>
</div></body></html>`;

  await sendEmail(email, `📈 Portfolio Update — ${sign}$${fmt(gain)} (${sign}${gainPct.toFixed(2)}%) · ${today}`, html);

  console.log(`Email sent to ${email}`);
  return { totalValue, gain, gainPct };
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const key = email.toLowerCase();
  if (await getUser(key)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const passwordHash = await bcrypt.hash(password, 12);
  await upsertUser(key, { passwordHash, investments: [], portfolioHistory: [], watchlist: [], createdAt: new Date() });

  const token = jwt.sign({ email: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, email: key });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const key  = email.toLowerCase();
  const user = await getUser(key);
  if (!user) return res.status(401).json({ error: 'No account found with that email.' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Incorrect password.' });

  const token = jwt.sign({ email: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, email: key });
});

// ── Data routes (auth required) ───────────────────────────────────────────────

app.get('/api/me', requireAuth, async (req, res) => {
  const user = await getUser(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({
    email: req.user.email,
    investments:      user.investments      || [],
    portfolioHistory: user.portfolioHistory || [],
    watchlist:        user.watchlist        || [],
  });
});

app.post('/api/data', requireAuth, async (req, res) => {
  const { investments, portfolioHistory, watchlist } = req.body;
  if (!Array.isArray(investments)) return res.status(400).json({ error: 'investments must be an array.' });
  const update = { investments };
  if (Array.isArray(portfolioHistory)) update.portfolioHistory = portfolioHistory;
  if (Array.isArray(watchlist))        update.watchlist = watchlist;
  await upsertUser(req.user.email, update);
  res.json({ ok: true });
});

app.post('/api/send-email', requireAuth, async (req, res) => {
  try {
    const user = await getUser(req.user.email);
    if (!user?.investments?.length) return res.status(400).json({ error: 'Add investments first.' });
    const result = await sendPortfolioEmail(req.user.email, user.investments);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-alert', requireAuth, async (req, res) => {
  const { ticker, currentPrice, targetPrice, direction } = req.body;
  if (!ticker || !currentPrice || !targetPrice) return res.status(400).json({ error: 'Missing fields.' });
  try {
    const transporter = createTransporter();
    const sign = direction === 'above' ? '▲' : '▼';
    await sendEmail(
      req.user.email,
      `🔔 Price Alert: ${ticker} ${sign} $${currentPrice.toFixed(2)}`,
      `<div style="font-family:sans-serif;background:#0d0f1a;color:#e2e8f0;padding:32px;border-radius:12px;max-width:480px;margin:0 auto;">
        <h2 style="color:#60a5fa;margin-bottom:8px;">🔔 Price Alert Triggered</h2>
        <p style="font-size:1.1rem;margin-bottom:20px;">
          <strong style="color:#e2e8f0;">${ticker}</strong> has crossed your target price.
        </p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:10px;color:#5a6380;">Current Price</td><td style="padding:10px;font-weight:700;color:#4ade80;">$${currentPrice.toFixed(2)}</td></tr>
          <tr><td style="padding:10px;color:#5a6380;">Your Target</td><td style="padding:10px;">$${targetPrice.toFixed(2)} (${direction})</td></tr>
        </table>
        <p style="margin-top:24px;font-size:11px;color:#5a6380;text-align:center;">Investment Tracker · Price Alert</p>
      </div>`
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Alert email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Keep-alive ping ───────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Health check (shows which env vars are present) ───────────────────────────
app.get('/api/health', (req, res) => res.json({
  mongodb:     !!process.env.MONGODB_URI,
  resend:      process.env.RESEND_API_KEY ? 'SET' : 'NOT SET',
  cron_secret: !!process.env.CRON_SECRET,
  node_env:    process.env.NODE_ENV || 'not set',
}));

// ── GitHub Actions cron trigger for daily emails ──────────────────────────────
app.post('/api/cron-emails', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const users = await getAllUsers();
    let sent = 0, skipped = 0;
    for (const user of users) {
      if (!user.investments?.length) { skipped++; continue; }
      try {
        await sendPortfolioEmail(user.email, user.investments);
        sent++;
      } catch (err) {
        console.error(`Email failed for ${user.email}:`, err.message);
      }
    }
    console.log(`Daily emails: ${sent} sent, ${skipped} skipped`);
    res.json({ ok: true, sent, skipped });
  } catch (err) {
    console.error('Cron email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Prices (public, no auth required) ────────────────────────────────────────

app.get('/api/prices', async (req, res) => {
  const raw = req.query.tickers;
  if (!raw) return res.status(400).json({ error: 'tickers param required' });
  const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  console.log('Fetching prices for:', tickers);
  try {
    const prices = await fetchPrices(tickers);
    console.log('Prices result:', prices);
    // If nothing came back, return errors so client knows what failed
    if (Object.keys(prices).length === 0) {
      return res.status(500).json({ error: 'All price lookups failed — Yahoo Finance may be blocking this server IP. Check Render logs.' });
    }
    res.json(prices);
  } catch (err) {
    console.error('Price fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cron: 8:00 AM ET, Mon–Fri ────────────────────────────────────────────────

cron.schedule('0 8 * * 1-5', async () => {
  console.log('Running daily email cron...');
  const users = await getAllUsers();
  for (const user of users) {
    const email = user.email;
    if (!user.investments?.length) continue;
    try {
      await sendPortfolioEmail(email, user.investments);
    } catch (err) {
      console.error(`Cron email failed for ${email}:`, err.message);
    }
  }
}, { timezone: 'America/New_York' });

// ── Start ─────────────────────────────────────────────────────────────────────

connectDB().then(connected => {
  useDB = connected;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Daily emails scheduled for 8:00 AM ET on weekdays.');
  });
});
