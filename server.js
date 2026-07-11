const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

app.get('/', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'index.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'ready' });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages } = req.body || {};

    if (!apiKey || !openai) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY is not set. Add it to your environment before starting the server.'
      });
    }

    const normalizedMessages = Array.isArray(messages)
      ? messages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content || '')
        }))
      : [{ role: 'user', content: String(req.body?.message || '') }];

    const completion = await openai.responses.create({
      model: 'gpt-4o-mini',
      instructions: system || 'You are HeriTech AI, a friendly cultural guide for Orang Ulu heritage and beadwork.',
      input: normalizedMessages
    });

    const reply = completion.output_text || '';
    return res.json({ reply });
  } catch (error) {
    console.error('Chat error:', error);
    return res.status(500).json({
      error: error?.message || 'Unexpected server error'
    });
  }
});

app.listen(port, () => {
  console.log(`HeriTech backend running on http://localhost:${port}`);
});
