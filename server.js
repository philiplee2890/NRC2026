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

app.post('/api/tts', async (req, res) => {
  try {
    if (!apiKey || !openai) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY is not set. Add it to your environment before starting the server.'
      });
    }

    const input = String(req.body?.text || '').slice(0, 4096);
    if (!input.trim()) {
      return res.status(400).json({ error: 'No text provided to speak.' });
    }

    const lang = req.body?.lang === 'ms' ? 'ms' : 'en';
    const instructions = lang === 'ms'
      ? 'Speak in Bahasa Malaysia (Malay) as a warm, friendly Malaysian woman narrating a museum tour — natural Malaysian pronunciation, intonation, and pacing, not a foreign accent.'
      : 'Speak warmly and naturally, like a friendly cultural guide narrating a museum tour. Use relaxed, human pacing with clear pronunciation, especially for Orang Ulu and beadwork-related terms.';

    // opus is OpenAI's low-latency streaming format (smaller/faster to
    // encode than mp3), and speech.body is already a Node stream, so we
    // pipe bytes to the client as they're generated instead of buffering
    // the whole clip first — audio starts arriving well before the full
    // response is ready.
    const speech = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'shimmer',
      input,
      instructions,
      response_format: 'opus'
    });

    res.set('Content-Type', 'audio/ogg');
    speech.body.on('error', (err) => {
      console.error('TTS stream error:', err);
      res.end();
    });
    speech.body.pipe(res);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({
      error: error?.message || 'Unexpected TTS error'
    });
  }
});

app.post('/api/translate', async (req, res) => {
  try {
    if (!apiKey || !openai) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY is not set. Add it to your environment before starting the server.'
      });
    }

    const text = String(req.body?.text || '').slice(0, 4096);
    if (!text.trim()) {
      return res.status(400).json({ error: 'No text provided to translate.' });
    }

    const target = req.body?.target === 'ms' ? 'ms' : 'en';
    const targetName = target === 'ms' ? 'Bahasa Malaysia (Malay)' : 'English';

    const completion = await openai.responses.create({
      model: 'gpt-4o-mini',
      instructions: `Translate the user's message fully into natural, conversational ${targetName}. Translate every word, including common nouns like "manik"/"beads" — do not leave source-language words untranslated unless they are proper names. Reply with only the translation — no notes, no quotation marks, no preamble.`,
      input: [{ role: 'user', content: text }]
    });

    return res.json({ text: completion.output_text || '' });
  } catch (error) {
    console.error('Translate error:', error);
    return res.status(500).json({
      error: error?.message || 'Unexpected translate error'
    });
  }
});

app.listen(port, () => {
  console.log(`HeriTech backend running on http://localhost:${port}`);
});
