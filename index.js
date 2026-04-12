const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const SALES_NUMBER = process.env.SALES_NUMBER;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BRIGHTREPLY_URL = process.env.BRIGHTREPLY_URL;
const STRIPE_PAYMENT_LINK = process.env.STRIPE_PAYMENT_LINK;

const client = twilio(TWILIO_SID, TWILIO_TOKEN);

const conversations = {};
const closedDeals = [];
const cancelledClients = [];
const pendingAssignment = [];
const twilioInventory = [];
let leads = JSON.parse(fs.readFileSync('leads.json', 'utf8'));

function saveLeads() {
  fs.writeFileSync('leads.json', JSON.stringify(leads, null, 2));
}
const clientStatuses = {};
let autoBuyEnabled = false;

async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
  } catch(e) {
    console.error('Telegram error:', e.message);
  }
}

async function sendSMS(to, body) {
  try {
    await client.messages.create({ body, from: SALES_NUMBER, to });
    console.log('SMS sent to', to);
  } catch(e) {
    console.error('SMS error:', e.message);
  }
}

async function askClaude(systemPrompt, messages) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages
  }, {
    headers: {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });
  return res.data.content[0].text;
}

function getSystemPrompt(lead) {
  return `You are a friendly sales assistant for BrightReply — a service that automatically texts back customers who call a local business and get no answer.

You are texting ${lead.name}, a ${lead.type} in Wales.

Your goal is to:
1. Explain the service simply and clearly
2. Handle any objections naturally and honestly
3. Close the deal — get them to agree to try it free for 14 days
4. Once they agree, ask them: "Almost done! What would you like your automatic text reply to say when customers call and get no answer? Keep it short and friendly — I will set it up exactly as you write it 😊"
5. Wait for their custom message reply
6. Once they give their custom message respond with exactly:
DEAL_CLOSED
CUSTOM_MESSAGE: [their exact message here]

Key facts:
- 14 day free trial, no card needed to start
£14.99/month after that, cancel any time
- Takes 2 minutes to set up on their phone
- When a customer calls and gets no answer, they automatically get a text back
- Saves lost customers — one saved booking pays for months of the service

Tone:
- Friendly and natural, not robotic
- Like a real person texting
- Keep messages short — 2-3 sentences max
- Do not use bullet points in SMS
- Be honest, do not oversell

If they say no or not interested, be polite and wish them well. Do not keep pushing.`;
}

function getSetupGuide(lead, twilioNumber) {
  return `Hi! Great news — you are all set up with BrightReply 🎉

Here is how to activate it in 2 minutes:

1. Open your phone dialler
2. Type exactly this and press call:
**61*${twilioNumber}*11*20#

3. You will hear a confirmation beep
4. Done — you are live!

To test it: call your number from another phone and do not answer. You should get a text back within seconds.

Your 14 day free trial starts now. After that it is just £14.99/month — I will send you a payment link before the trial ends.

Any questions just reply here! 😊`;
}

function isBlacklisted(phone) {
  return cancelledClients.some(c => c.phone === phone);
}

async function handleReply(from, body) {
  if (isBlacklisted(from)) {
    console.log('Blacklisted number replied — ignoring:', from);
    return;
  }
  if (!conversations[from]) {
    console.log('Unknown number replied:', from);
    return;
  }
  const conv = conversations[from];
  conv.messages.push({ role: 'user', content: body });
  console.log(`Reply from ${conv.lead.name}: ${body}`);
  const reply = await askClaude(getSystemPrompt(conv.lead), conv.messages);
  if (reply.includes('DEAL_CLOSED')) {
    const lines = reply.split('\n');
    const customLine = lines.find(l => l.startsWith('CUSTOM_MESSAGE:'));
    const customMessage = customLine ? customLine.replace('CUSTOM_MESSAGE:', '').trim() : null;
    await handleDealClosed(from, conv, customMessage);
    return;
  }
  conv.messages.push({ role: 'assistant', content: reply });
  await sendSMS(from, reply);
}

async function handleDealClosed(phone, conv, customMessage) {
  const lead = conv.lead;
  const finalMessage = customMessage || `Hi! Sorry we missed your call at ${lead.name}. We will ring you back shortly — or reply here to book!`;

  const available = twilioInventory.filter(n => n.status === 'available');
  if (available.length === 0 && autoBuyEnabled) {
    try {
      const numbers = await client.availablePhoneNumbers('GB').mobile.list({ limit: 1, smsEnabled: true });
      if (numbers.length > 0) {
        const purchased = await client.incomingPhoneNumbers.create({ phoneNumber: numbers[0].phoneNumber });
        twilioInventory.push({
          number: purchased.phoneNumber,
          friendlyName: 'Auto-bought',
          status: 'available',
          addedAt: new Date().toISOString()
        });
        console.log('Auto-bought number:', purchased.phoneNumber);
        await sendTelegram(`🤖 <b>Auto-bought Twilio number</b>\n${purchased.phoneNumber}\nAdded to inventory automatically.`);
      }
    } catch(e) {
      console.log('Auto-buy failed:', e.message);
      await sendTelegram(`⚠️ <b>Auto-buy failed</b>\n${e.message}\nPlease buy a number manually.`);
    }
  }

  pendingAssignment.push({
    phone,
    name: lead.name,
    type: lead.type,
    customMessage: finalMessage,
    closedAt: new Date().toISOString()
  });

  closedDeals.push({
    name: lead.name,
    type: lead.type,
    phone,
    customMessage: finalMessage,
    closedAt: new Date().toISOString(),
    status: 'pending'
  });

  clientStatuses[phone] = 'pending';

  await sendTelegram(
    `🎉 <b>New deal closed — ${lead.name}</b>\n` +
    `Type: ${lead.type}\n` +
    `Phone: ${phone}\n` +
    `Custom message: ${finalMessage}\n\n` +
    `⚠️ Open BrightSales app and assign a Twilio number to activate their service!`
  );

  await sendSMS(phone, `Hi! Great news — your BrightReply service is almost ready. We are just setting up your dedicated number and will send you the activation instructions within the hour. Excited to have you on board! 😊`);
}

async function assignNumber(clientPhone, twilioNumber) {
  const pending = pendingAssignment.find(p => p.phone === clientPhone);
  const deal = closedDeals.find(d => d.phone === clientPhone);

  if (!pending && !deal) return { success: false, error: 'Client not found' };

  const clientData = pending || deal;

  const inv = twilioInventory.find(n => n.number === twilioNumber);
  if (inv) {
    inv.status = 'assigned';
    inv.assignedTo = clientData.name;
    inv.assignedAt = new Date().toISOString();
  }

  if (deal) {
    deal.twilioNumber = twilioNumber;
    deal.status = 'trial';
  }
  clientStatuses[clientPhone] = 'trial';

  const idx = pendingAssignment.findIndex(p => p.phone === clientPhone);
  if (idx > -1) pendingAssignment.splice(idx, 1);

  const setupGuide = getSetupGuide(clientData, twilioNumber);
  await sendSMS(clientPhone, setupGuide);

  try {
    await axios.post(`${BRIGHTREPLY_URL}/add-client`, {
      name: clientData.name,
      type: clientData.type,
      phone: clientPhone,
      twilioNumber,
      message: clientData.customMessage
    });
  } catch(e) {
    console.log('Could not auto-add to BrightReply');
  }

  await sendTelegram(
    `✅ <b>Client activated — ${clientData.name}</b>\n` +
    `Twilio number: ${twilioNumber}\n` +
    `Setup guide sent!`
  );

  return { success: true };
}

async function startOutreach(specificPhones, limit) {
  const targets = specificPhones ? leads.filter(l => specificPhones.includes(l.phone)) : leads;
  const maxLeads = limit || 10;
  let count = 0;
  for (const lead of targets) {
    if (count >= maxLeads) break;
    if (isBlacklisted(lead.phone)) { console.log('Skipping blacklisted:', lead.name); continue; }
    if (conversations[lead.phone]) { console.log('Already contacted:', lead.name); continue; }
    const openingMessage = `Hi! I noticed ${lead.name} online. I help local ${lead.type.toLowerCase()}s automatically text back any missed calls so customers don't go elsewhere. Free 14 day trial — takes 2 mins to set up. Worth a quick chat?`;
    conversations[lead.phone] = {
      lead,
      messages: [{ role: 'assistant', content: openingMessage }],
      startedAt: new Date().toISOString()
    };
    await sendSMS(lead.phone, openingMessage);
    count++;
    await new Promise(r => setTimeout(r, 3000));
  }
  await sendTelegram(`📤 <b>BrightSales outreach complete</b>\nMessaged ${count} new businesses.`);
}
app.post('/sms', (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  handleReply(from, body).catch(console.error);
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.post('/start-outreach', async (req, res) => {
  const { phones, limit } = req.body || {};
  res.json({ message: 'Outreach started' });
  startOutreach(phones, limit).catch(console.error);
});

app.get('/conversations', (req, res) => {
  res.json({ conversations, closedDeals, cancelledClients, leads, clientStatuses, pendingAssignment, twilioInventory });
});

app.post('/add-lead', (req, res) => {
  const { name, type, phone } = req.body;
  if (!name || !phone) return res.json({ success: false, error: 'Missing fields' });
  if (isBlacklisted(phone)) return res.json({ success: false, error: 'This number has cancelled — do not contact again' });
  const existing = leads.find(l => l.phone === phone);
  if (existing) return res.json({ success: false, error: 'Already exists' });
  leads.push({ name, type, phone });
saveLeads();
  res.json({ success: true });
});

app.post('/add-inventory', (req, res) => {
  const { number, friendlyName } = req.body;
  if (!number) return res.json({ success: false, error: 'Missing number' });
  const existing = twilioInventory.find(n => n.number === number);
  if (existing) return res.json({ success: false, error: 'Number already in inventory' });
  twilioInventory.push({
    number,
    friendlyName: friendlyName || number,
    status: 'available',
    addedAt: new Date().toISOString()
  });
  res.json({ success: true });
});

app.post('/assign-number', async (req, res) => {
  const { clientPhone, twilioNumber } = req.body;
  const result = await assignNumber(clientPhone, twilioNumber);
  res.json(result);
});

app.post('/update-status', async (req, res) => {
  const { phone, status } = req.body;
  if (!phone || !status) return res.json({ success: false });
  clientStatuses[phone] = status;
  const deal = closedDeals.find(d => d.phone === phone);
  if (deal) deal.status = status;
  if (status === 'cancelled') {
    const name = deal ? deal.name : phone;
    if (!cancelledClients.find(c => c.phone === phone)) {
      cancelledClients.push({ phone, name, cancelledAt: new Date().toISOString(), reason: 'manual' });
    }
    try { await axios.post(`${BRIGHTREPLY_URL}/cancel-client`, { phone }); } catch(e) {}
    await sendTelegram(`❌ <b>Client cancelled — ${name}</b>\nPhone: ${phone}`);
  }
  if (status === 'paid') {
    const name = deal ? deal.name : phone;
    await sendTelegram(`💰 <b>Client paid — ${name}</b>\nPhone: ${phone}`);
  }
  res.json({ success: true });
});

app.post('/send-payment-link', async (req, res) => {
  const { phone, name } = req.body;
  const stripeLink = STRIPE_PAYMENT_LINK || 'https://buy.stripe.com/your-link-here';
  await sendSMS(phone, `Hi ${name}! Your 14 day free trial of BrightReply has ended. To keep your missed call replies running it is just £14.99/month: ${stripeLink} — cancel any time. Any questions just reply here!`);
  res.json({ success: true });
});

app.post('/set-auto-buy', (req, res) => {
  autoBuyEnabled = req.body.enabled === true;
  console.log('Auto-buy set to:', autoBuyEnabled);
  res.json({ success: true, autoBuyEnabled });
});
app.post('/find-leads', async (req, res) => {
  const { town, type } = req.body;
  if (!town || !type) return res.json({ success: false, error: 'Missing town or type' });

  const GOOGLE_KEY = process.env.GOOGLE_PLACES_KEY;
  const query = `${type} in ${town} Wales`;

  try {
    const searchRes = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query, key: GOOGLE_KEY }
    });

    const places = searchRes.data.results || [];
    const newLeads = [];
    const skipped = [];

    for (const place of places.slice(0, 20)) {
      try {
        const detailRes = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
          params: {
            place_id: place.place_id,
            fields: 'name,formatted_phone_number,website',
            key: GOOGLE_KEY
          }
        });

        const details = detailRes.data.result || {};
        const phone = details.formatted_phone_number;
        const website = details.website;
        const name = place.name;

        if (!phone) { skipped.push({ name, reason: 'no phone' }); continue; }

        let formattedPhone = phone.replace(/\s/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '+44' + formattedPhone.slice(1);
        if (!formattedPhone.startsWith('+')) formattedPhone = '+44' + formattedPhone;

        if (isBlacklisted(formattedPhone)) { skipped.push({ name, reason: 'blacklisted' }); continue; }
        if (leads.find(l => l.phone === formattedPhone)) { skipped.push({ name, reason: 'already exists' }); continue; }
        if (closedDeals.find(d => d.phone === formattedPhone)) { skipped.push({ name, reason: 'already a client' }); continue; }

       

        leads.push({ name, type, phone: formattedPhone });
saveLeads();
        newLeads.push({ name, phone: formattedPhone });

        await new Promise(r => setTimeout(r, 200));
      } catch(e) {
        console.error('Place detail error:', e.message);
      }
    }

    res.json({ success: true, found: newLeads.length, skipped: skipped.length, leads: newLeads });
  } catch(e) {
    console.error('Places search error:', e.message);
    res.json({ success: false, error: e.message });
  }
});
app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ results: [] });
  const allEntries = [
    ...leads.map(l => ({ ...l, source: 'lead' })),
    ...closedDeals.map(d => ({ ...d, source: 'client' })),
    ...cancelledClients.map(c => ({ ...c, source: 'cancelled' }))
  ];
  const seen = new Set();
  const results = allEntries.filter(e => {
    const match = (e.name||'').toLowerCase().includes(q) || (e.phone||'').includes(q);
    if (!match || seen.has(e.phone)) return false;
    seen.add(e.phone);
    return true;
  });
  res.json({ results });
});

app.get('/', (req, res) => {
  if (fs.existsSync('dashboard.html')) {
    res.send(fs.readFileSync('dashboard.html', 'utf8'));
  } else {
    res.send('BrightSales is running');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('BrightSales running on port', PORT);
  sendTelegram('💼 <b>BrightSales is online</b>\nReady to start outreach.');
});
