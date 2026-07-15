const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const app = express();
const port = process.env.PORT || 3000;
const httpsPort = process.env.HTTPS_PORT || 3443;

// certs/ lives one level ABOVE this folder (not under __dirname) so it can
// never be picked up by express.static(__dirname) below — server-key.pem is
// a private key, and static-serving it would let anyone on the network
// impersonate this server over HTTPS.
const CERTS_DIR = path.join(__dirname, '..', 'certs');

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

app.get('/', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'index.html'));
});

// Lets a phone/tablet download the mkcert local root CA over plain HTTP
// (no secure context needed to download a file) so it can be installed as a
// trusted profile — after that, https://<this PC's LAN IP>:3443 loads with
// no warnings and unlocks secure-context-only features like voice input.
// Safe to serve publicly: this is the CA's public certificate, not its key.
app.get('/rootCA.pem', (_req, res) => {
  const caPath = path.join(CERTS_DIR, 'rootCA.pem');
  if (!fs.existsSync(caPath)) {
    return res.status(404).send('No local CA generated on this server yet.');
  }
  res.set('Content-Type', 'application/x-x509-ca-cert');
  res.set('Content-Disposition', 'attachment; filename="HeriTech-local-CA.pem"');
  res.sendFile(caPath);
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

// ============================================================
//  ARDUINO USB BRIDGE — lets devices that can't use the Web
//  Serial API (Safari on iPad/iPhone, since Apple requires every
//  iOS browser to use WebKit and WebKit doesn't implement it) send
//  G-code to the Arduino that's physically plugged into whichever
//  machine is running this server. The browser POSTs the full
//  G-code text over plain HTTP; this process relays it line-by-line
//  over the real serial port, waiting for the same "ok" handshake
//  Gcode-streamer/MAIN_CODE.ino already sends — mirrors
//  sendToArduinoUSB() in script.js, just running over Wi-Fi instead
//  of Web Serial.
// ============================================================
let arduinoPort   = null;
let arduinoParser = null;
let lineWaiters   = []; // resolvers waiting on the next line from the board
let sendState     = { inProgress: false, total: 0, sent: 0, error: null };

async function findArduinoPortPath() {
  const ports = await SerialPort.list();
  // Prefer a genuine Arduino (vendorId 2341) or a common clone UART chip
  // (CH340 = 1a86, CP210x = 10c4) over whatever else happens to be plugged in.
  const byId = ports.find(p => /^(2341|1a86|10c4)$/i.test(p.vendorId || ''));
  if (byId) return byId.path;
  const byName = ports.find(p => /arduino|ch340|cp210|usb.?serial/i.test(p.manufacturer || ''));
  if (byName) return byName.path;
  return ports[0] ? ports[0].path : null;
}

async function connectArduino() {
  if (arduinoPort && arduinoPort.isOpen) return arduinoPort.path;

  const portPath = await findArduinoPortPath();
  if (!portPath) throw new Error('No serial port found — is the Arduino plugged into this computer?');

  await new Promise((resolve, reject) => {
    arduinoPort = new SerialPort({ path: portPath, baudRate: 115200 }, (err) => err ? reject(err) : resolve());
  });

  arduinoParser = arduinoPort.pipe(new ReadlineParser({ delimiter: '\n' }));
  arduinoParser.on('data', (line) => {
    line = line.trim();
    if (line && lineWaiters.length) lineWaiters.shift()(line);
  });
  arduinoPort.on('close', () => { arduinoPort = null; arduinoParser = null; });
  arduinoPort.on('error', (err) => console.error('Serial port error:', err.message));

  return portPath;
}

function waitForArduinoLine(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const onLine = (line) => { clearTimeout(timer); resolve(line); };
    const timer = setTimeout(() => {
      const idx = lineWaiters.indexOf(onLine);
      if (idx >= 0) lineWaiters.splice(idx, 1);
      reject(new Error('Arduino did not respond in time'));
    }, timeoutMs);
    lineWaiters.push(onLine);
  });
}

app.get('/api/gcode/status', (_req, res) => {
  res.json({
    connected: !!(arduinoPort && arduinoPort.isOpen),
    portPath: arduinoPort ? arduinoPort.path : null,
    ...sendState
  });
});

app.post('/api/gcode/send', async (req, res) => {
  if (sendState.inProgress) {
    return res.status(409).json({ error: 'A send is already in progress on this bridge' });
  }

  const gcode = String(req.body?.gcode || '');
  const lines = gcode.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith(';'));
  if (!lines.length) {
    return res.status(400).json({ error: 'No G-code lines to send' });
  }

  try {
    await connectArduino();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  sendState = { inProgress: true, total: lines.length, sent: 0, error: null };
  res.json({ started: true, total: lines.length });

  // Fire-and-forget: the response above already went out, progress and
  // completion are picked up by the frontend polling /api/gcode/status.
  (async () => {
    try {
      for (let i = 0; i < lines.length; i++) {
        await new Promise((resolve, reject) => {
          arduinoPort.write(lines[i] + '\n', (err) => err ? reject(err) : resolve());
        });
        await waitForArduinoLine();
        sendState.sent = i + 1;
      }
    } catch (err) {
      sendState.error = err.message;
    } finally {
      sendState.inProgress = false;
    }
  })();
});

app.listen(port, () => {
  console.log(`HeriTech backend running on http://localhost:${port}`);
});

// HTTPS listener, only if a cert was generated (see certs/README or the
// mkcert setup done for this project) — this is what iPad/iPhone need for
// voice input, since Safari only grants microphone access in a secure
// context (https://, or literally 'localhost', which doesn't apply to a
// second device on the LAN).
const certFile = path.join(CERTS_DIR, 'server.pem');
const keyFile  = path.join(CERTS_DIR, 'server-key.pem');
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  https.createServer({
    cert: fs.readFileSync(certFile),
    key:  fs.readFileSync(keyFile)
  }, app).listen(httpsPort, () => {
    console.log(`HeriTech backend also running on https://localhost:${httpsPort} (and your LAN IP)`);
  });
} else {
  console.log('No HTTPS cert found in certs/ — voice input will only work at http://localhost, not from other devices.');
}
