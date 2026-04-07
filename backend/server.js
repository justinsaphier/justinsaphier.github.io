require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const yahooFinance = require('yahoo-finance2').default;
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());

// ── Data helpers ──────────────────────────────────────────────────────────────

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { email: '', investments: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { email: '', investments: [] }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Stock price fetching ──────────────────────────────────────────────────────

async function fetchPrices(tickers) {
  const results = {};
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const quote = await yahooFinance.quote(ticker);
      const price = quote.regularMarketPrice;
      const prevClose = quote.regularMarketPreviousClose;
      const dayChangePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
      results[ticker] = { price, dayChangePct };
    } catch (err) {
      console.error(`Failed to fetch ${ticker}:`, err.message);
    }
  }));
  return results;
}

// ── Email logic ───────────────────────────────────────────────────────────────

function fmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function buildAndSendEmail() {
  const data = loadData();

  if (!data.email) throw new Error('No email address saved.');
  if (!data.investments || !data.investments.length) throw new Error('No investments saved.');

  const tickers = data.investments.map(i => i.ticker);
  const prices = await fetchPrices(tickers);

  let totalCost = 0;
  let totalValue = 0;
  const alerts = [];
  const rows = [];

  for (const inv of data.investments) {
    const cost = inv.shares * inv.purchasePrice;
    totalCost += cost;

    const p = prices[inv.ticker];
    if (p) {
      const value = inv.shares * p.price;
      const gain = value - cost;
      const gainPct = (gain / cost) * 100;
      totalValue += value;

      const gainColor = gain >= 0 ? '#4ade80' : '#f87171';
      const dayColor  = p.dayChangePct >= 0 ? '#4ade80' : '#f87171';
      const sign = gain >= 0 ? '+' : '';
      const daySign = p.dayChangePct >= 0 ? '+' : '';

      rows.push(`
        <tr>
          <td style="padding:10px 14px;font-weight:700;color:#60a5fa;">${inv.ticker}</td>
          <td style="padding:10px 14px;">${inv.shares.toLocaleString()}</td>
          <td style="padding:10px 14px;">$${fmt(p.price)}</td>
          <td style="padding:10px 14px;">$${fmt(value)}</td>
          <td style="padding:10px 14px;color:${gainColor};">${sign}$${fmt(gain)} (${sign}${gainPct.toFixed(2)}%)</td>
          <td style="padding:10px 14px;color:${dayColor};">${daySign}${p.dayChangePct.toFixed(2)}%</td>
        </tr>`);

      if (Math.abs(p.dayChangePct) >= 5) {
        const dir = p.dayChangePct > 0 ? 'surged' : 'dropped';
        alerts.push(`<b>${inv.ticker}</b> ${dir} <b>${Math.abs(p.dayChangePct).toFixed(1)}%</b> today`);
      }
    }
  }

  const gain = totalValue - totalCost;
  const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : 0;
  const sign = gain >= 0 ? '+' : '';
  const gainColor = gain >= 0 ? '#4ade80' : '#f87171';
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const alertBlock = alerts.length
    ? `<div style="margin-top:24px;padding:14px 18px;background:#1e2235;border-left:3px solid #facc15;border-radius:6px;font-size:14px;line-height:1.7;">
         ⚠️ <b>Notable Moves</b><br>${alerts.join('<br>')}
       </div>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0f1a;font-family:'Segoe UI',system-ui,sans-serif;color:#e2e8f0;">
  <div style="max-width:620px;margin:0 auto;padding:32px 16px;">

    <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0 0 4px;">📈 Portfolio Update</h1>
    <p style="color:#5a6380;font-size:13px;margin:0 0 28px;">${today}</p>

    <!-- Summary cards -->
    <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;">
      <div style="flex:1;min-width:130px;background:#161928;border:1px solid #2a2f4a;border-radius:10px;padding:14px 16px;text-align:center;">
        <div style="font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;">Total Value</div>
        <div style="font-size:22px;font-weight:700;">$${fmt(totalValue)}</div>
      </div>
      <div style="flex:1;min-width:130px;background:#161928;border:1px solid #2a2f4a;border-radius:10px;padding:14px 16px;text-align:center;">
        <div style="font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;">Total Cost</div>
        <div style="font-size:22px;font-weight:700;">$${fmt(totalCost)}</div>
      </div>
      <div style="flex:1;min-width:130px;background:#161928;border:1px solid #2a2f4a;border-radius:10px;padding:14px 16px;text-align:center;">
        <div style="font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;">Total Gain / Loss</div>
        <div style="font-size:22px;font-weight:700;color:${gainColor};">${sign}$${fmt(gain)}</div>
      </div>
      <div style="flex:1;min-width:130px;background:#161928;border:1px solid #2a2f4a;border-radius:10px;padding:14px 16px;text-align:center;">
        <div style="font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;">% Return</div>
        <div style="font-size:22px;font-weight:700;color:${gainColor};">${sign}${gainPct.toFixed(2)}%</div>
      </div>
    </div>

    <!-- Holdings table -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#161928;border:1px solid #2a2f4a;border-radius:10px;overflow:hidden;font-size:13px;border-collapse:separate;border-spacing:0;">
      <thead>
        <tr style="background:#1e2235;">
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;font-weight:600;">Ticker</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;font-weight:600;">Shares</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;font-weight:600;">Price</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;font-weight:600;">Value</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;font-weight:600;">Gain / Loss</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#5a6380;text-transform:uppercase;letter-spacing:.07em;font-weight:600;">Today</th>
        </tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
    </table>

    ${alertBlock}

    <p style="margin-top:28px;font-size:11px;color:#5a6380;text-align:center;">
      Sent by Investment Tracker · Daily at 8:00 AM ET on weekdays
    </p>
  </div>
</body>
</html>`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from: `"Investment Tracker" <${process.env.SMTP_USER}>`,
    to: data.email,
    subject: `📈 Portfolio Update — ${sign}$${fmt(gain)} (${sign}${gainPct.toFixed(2)}%) · ${today}`,
    html,
  });

  console.log(`Email sent to ${data.email}`);
  return { totalValue, gain, gainPct };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/data', (req, res) => res.json(loadData()));

app.post('/api/data', (req, res) => {
  const { investments, email } = req.body;
  if (!Array.isArray(investments)) return res.status(400).json({ error: 'investments must be an array' });
  saveData({ investments, email: email || '' });
  res.json({ ok: true });
});

app.get('/api/prices', async (req, res) => {
  const raw = req.query.tickers;
  if (!raw) return res.status(400).json({ error: 'tickers param required' });
  const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  try {
    res.json(await fetchPrices(tickers));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-email', async (req, res) => {
  try {
    const result = await buildAndSendEmail();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron: daily at 8:00 AM ET, Mon–Fri ───────────────────────────────────────

cron.schedule('0 8 * * 1-5', () => {
  console.log('Running scheduled email...');
  buildAndSendEmail().catch(err => console.error('Cron email failed:', err.message));
}, { timezone: 'America/New_York' });

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Investment tracker server running on http://localhost:${PORT}`);
  console.log('Daily email scheduled for 8:00 AM ET on weekdays.');
});
