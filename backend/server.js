require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const twilio = require('twilio');
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
  if (!fs.existsSync(DATA_FILE)) return { phone: '', investments: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { phone: '', investments: [] }; }
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
      const dayChangePct = prevClose
        ? ((price - prevClose) / prevClose) * 100
        : 0;
      results[ticker] = { price, dayChangePct };
    } catch (err) {
      console.error(`Failed to fetch ${ticker}:`, err.message);
    }
  }));
  return results;
}

// ── SMS logic ─────────────────────────────────────────────────────────────────

async function buildAndSendSMS() {
  const data = loadData();

  if (!data.phone) throw new Error('No phone number saved.');
  if (!data.investments || !data.investments.length) throw new Error('No investments saved.');

  const tickers = data.investments.map(i => i.ticker);
  const prices = await fetchPrices(tickers);

  let totalCost = 0;
  let totalValue = 0;
  const alerts = [];

  for (const inv of data.investments) {
    const cost = inv.shares * inv.purchasePrice;
    totalCost += cost;

    const p = prices[inv.ticker];
    if (p) {
      totalValue += inv.shares * p.price;
      // Alert if a single holding moved ≥5% in a day
      if (Math.abs(p.dayChangePct) >= 5) {
        const dir = p.dayChangePct > 0 ? 'surged' : 'dropped';
        alerts.push(`${inv.ticker} ${dir} ${Math.abs(p.dayChangePct).toFixed(1)}% today`);
      }
    }
  }

  const gain = totalValue - totalCost;
  const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : 0;
  const sign = gain >= 0 ? '+' : '';

  let message =
    `📈 Portfolio Update\n` +
    `Value:  $${totalValue.toFixed(2)}\n` +
    `Gain/Loss: ${sign}$${gain.toFixed(2)} (${sign}${gainPct.toFixed(2)}%)`;

  if (alerts.length) {
    message += `\n\n⚠️ ${alerts.join('\n⚠️ ')}`;
  }

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  await client.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: data.phone,
  });

  console.log(`SMS sent to ${data.phone}`);
  return message;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Get saved data (investments + phone)
app.get('/api/data', (req, res) => {
  res.json(loadData());
});

// Save investments + phone
app.post('/api/data', (req, res) => {
  const { investments, phone } = req.body;
  if (!Array.isArray(investments)) {
    return res.status(400).json({ error: 'investments must be an array' });
  }
  saveData({ investments, phone: phone || '' });
  res.json({ ok: true });
});

// Fetch live prices for a comma-separated list of tickers
app.get('/api/prices', async (req, res) => {
  const raw = req.query.tickers;
  if (!raw) return res.status(400).json({ error: 'tickers param required' });
  const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  try {
    const prices = await fetchPrices(tickers);
    res.json(prices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger SMS immediately (used by "Send Test SMS" button)
app.post('/api/send-sms', async (req, res) => {
  try {
    const message = await buildAndSendSMS();
    res.json({ ok: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron: send daily at 4:30 PM ET, Mon–Fri ───────────────────────────────────

cron.schedule('0 8 * * 1-5', () => {
  console.log('Running scheduled SMS...');
  buildAndSendSMS().catch(err => console.error('Cron SMS failed:', err.message));
}, { timezone: 'America/New_York' });

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Investment tracker server running on http://localhost:${PORT}`);
  console.log('Daily SMS scheduled for 8:00 AM ET on weekdays.');
});
