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

const client = twilio(TWILIO_SID, TWILIO_TOKEN);

const conversations = {};
const closedDeals = [];
const leads = JSON.parse(fs.readFileSync('leads.json', 'utf8'));

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
    await client.messages.create({
      body,
      from: SALES_NUMBER,
      to
    });
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
4. Once they agree, respond with exactly: DEAL_CLOSED

Key facts:
- 14 day free trial, no card needed to start
- £29/month after that, cancel any time
- Takes 2 minutes to set up on their phone
- When a customer calls and gets no answer, they automatically get a text back
- Saves lost customers — one saved booking pays for months of the service

Tone:
- Friendly and natural, not robotic
- Like a real person texting
- Keep messages short — 2-3 sentences max
- Don't use bullet points in SMS
- Be honest, don't oversell

If they say no or not interested, be polite and wish them well. Do not keep pushing.
If they agree or say yes, respond with DEAL_CLOSED on its own line.`;
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

Your 14 day free trial starts now. After that it is just £29/month — I will send you a payment link before the trial ends.

Any questions just reply here! 😊`;
}

async function handleReply(from, body) {
  if (!conversations[from]) {
    console.log('Unknown number replied:', from);
    return;
  }

  const conv = conversations[from];
  conv.messages.push({ role: 'user', content: body });

  console.log(`Reply from ${conv.lead.name}: ${body}`);

  const reply = await askClaude(getSystemPrompt(conv.lead), conv.messages);

  if (reply.includes('DEAL_CLOSED')) {
    await handleDealClosed(from, conv);
    return;
  }

  conv.messages.push({ role: 'assistant', content: reply });
  await sendSMS(from, reply);
}

async function handleDealClosed(phone, conv) {
  const lead = conv.lead;
  console.log('DEAL CLOSED:', lead.name);

  closedDeals.push({
    name: lead.name,
    type: lead.type,
    phone,
    closedAt: new Date().toISOString()
  });

  const setupGuide = getSetupGuide(lead, SALES_NUMBER);
  await sendSMS(phone, setupGuide);

  await sendTelegram(
    `🎉 <b>New client closed — ${lead.name}</b>\n` +
    `Type: ${lead.type}\n` +
    `Phone: ${phone}\n` +
    `Time: ${new Date().toLocaleString()}`
  );

  try {
    await axios.post(`${BRIGHTREPLY_URL}/add-client`, {
      name: lead.name,
      type: lead.type,
      phone,
      twilioNumber: SALES_NUMBER,
      message: `Hi! Sorry we missed your call at ${lead.name}. We will ring you back shortly — or reply here to book!`
    });
    console.log('Client added to BrightReply');
  } catch(e) {
    console.log('Could not auto-add to BrightReply — add manually');
  }
}

async function startOutreach() {
  console.log('Starting outreach to', leads.length, 'leads');
  await sendTelegram(`📤 <b>BrightSales starting outreach</b>\nMessaging ${leads.length} businesses now...`);

  for (const lead of leads) {
    if (conversations[lead.phone]) {
      console.log('Already contacted:', lead.name);
      continue;
    }

    const openingMessage = `Hi! I noticed ${lead.name} online. I help local ${lead.type.toLowerCase()}s automatically text back any missed calls so customers don't go elsewhere. Free 14 day trial — takes 2 mins to set up. Worth a quick chat?`;

    conversations[lead.phone] = {
      lead,
      messages: [{ role: 'assistant', content: openingMessage }],
      startedAt: new Date().toISOString()
    };

    await sendSMS(lead.phone, openingMessage);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('Outreach complete');
}

app.post('/sms', (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  console.log('Incoming SMS from', from, ':', body);
  handleReply(from, body).catch(console.error);
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.post('/start-outreach', async (req, res) => {
  res.json({ message: 'Outreach started' });
  startOutreach().catch(console.error);
});

app.get('/conversations', (req, res) => {
  res.json({ conversations, closedDeals, leads });
});

app.get('/', (req, res) => {
  res.send('BrightSales is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('BrightSales running on port', PORT);
  sendTelegram('💼 <b>BrightSales is online</b>\nReady to start outreach. Send POST to /start-outreach to begin.');
});
