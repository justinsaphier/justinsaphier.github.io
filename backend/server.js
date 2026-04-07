require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const yahoo      = require('yahoo-finance2').default;
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const fs         = require('fs');
const path       = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── User storage ──────────────────────────────────────────────────────────────
// { "email": { passwordHash, investments: [], createdAt } }

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUser(email) {
  return loadUsers()[email.toLowerCase()] || null;
}

function upsertUser(email, data) {
  const users = loadUsers();
  users[email.toLowerCase()] = { ...(users[email.toLowerCase()] || {}), ...data };
  saveUsers(users);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
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
    const result = await yahoo.search(ticker, { newsCount: 3, enableFuzzyQuery: false });
    return (result.news || [])
      .slice(0, 3)
      .map(n => n.title)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchPrices(tickers) {
  const results = {};
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const q = await yahoo.quote(ticker);
      const price    = q.regularMarketPrice;
      const prevClose = q.regularMarketPreviousClose;
      results[ticker] = {
        price,
        dayChangePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
      };
    } catch (err) {
      console.error(`fetchPrices ${ticker}:`, err.message);
    }
  }));
  return results;
}

// ── Email ─────────────────────────────────────────────────────────────────────

function fmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error(
      'Email is not configured. Add SMTP_HOST, SMTP_USER, and SMTP_PASS ' +
      'to your .env file (or Render environment variables) to enable emails.'
    );
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
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

  await createTransporter().sendMail({
    from:    `"Investment Tracker" <${process.env.SMTP_USER}>`,
    to:      email,
    subject: `📈 Portfolio Update — ${sign}$${fmt(gain)} (${sign}${gainPct.toFixed(2)}%) · ${today}`,
    html,
  });

  console.log(`Email sent to ${email}`);
  return { totalValue, gain, gainPct };
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const key = email.toLowerCase();
  if (getUser(key)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const passwordHash = await bcrypt.hash(password, 12);
  upsertUser(key, { passwordHash, investments: [], createdAt: new Date().toISOString() });

  const token = jwt.sign({ email: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, email: key });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const key  = email.toLowerCase();
  const user = getUser(key);
  if (!user) return res.status(401).json({ error: 'No account found with that email.' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Incorrect password.' });

  const token = jwt.sign({ email: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, email: key });
});

// ── Data routes (auth required) ───────────────────────────────────────────────

app.get('/api/me', requireAuth, (req, res) => {
  const user = getUser(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ email: req.user.email, investments: user.investments || [] });
});

app.post('/api/data', requireAuth, (req, res) => {
  const { investments } = req.body;
  if (!Array.isArray(investments)) return res.status(400).json({ error: 'investments must be an array.' });
  upsertUser(req.user.email, { investments });
  res.json({ ok: true });
});

app.post('/api/send-email', requireAuth, async (req, res) => {
  try {
    const user = getUser(req.user.email);
    if (!user?.investments?.length) return res.status(400).json({ error: 'Add investments first.' });
    const result = await sendPortfolioEmail(req.user.email, user.investments);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron: 8:00 AM ET, Mon–Fri ────────────────────────────────────────────────

cron.schedule('0 8 * * 1-5', async () => {
  console.log('Running daily email cron...');
  const users = loadUsers();
  for (const [email, user] of Object.entries(users)) {
    if (!user.investments?.length) continue;
    try {
      await sendPortfolioEmail(email, user.investments);
    } catch (err) {
      console.error(`Cron email failed for ${email}:`, err.message);
    }
  }
}, { timezone: 'America/New_York' });

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Daily emails scheduled for 8:00 AM ET on weekdays.');
});
