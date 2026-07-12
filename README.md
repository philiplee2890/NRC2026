# HeriTech Pattern Studio

A browser-based design studio for Orang Ulu beadwork motifs (Sarawak, Malaysia). Draw a pattern, save it to a personal Heritage Library, generate G-code from it, and send that G-code straight to an ESP32-driven XY plotter robot ("HeriTech") that reproduces the motif physically. A built-in AI guide answers cultural questions and shares fun facts, with voice input and read-aloud replies.

## Features

- **Draw mode** — pen, straight line, and eraser tools with adjustable brush size, a 6-color palette, undo, clear, and mirror symmetry.
- **Heritage Library** — save motifs locally (`localStorage`), reload or delete them, with live thumbnails.
- **Import SVG** — upload an `.svg` file straight into the Library. Paths (including curves), lines, polylines, polygons, circles, ellipses, and rects — including ones inside transformed `<g>` groups — are sampled into strokes and fit to the 500×500 canvas, ready to edit, export, or turn into G-code like any hand-drawn motif.
- **True vector SVG export** — download a pattern as a clean SVG, compatible with `svg2gcode`-style tools.
- **G-code generation** — turns your strokes into Grbl-compatible G-code sized for a 350×350mm work area, with a live syntax-highlighted preview.
- **Send to robot** — streams the generated G-code line-by-line to an ESP32 over a WebSocket (`ws://<esp32-ip>:81`).
- **AI cultural guide** — a drawer with two tabs:
  - **Fun Facts** — on-demand facts about Orang Ulu culture, beadwork, and traditions, with history and replay.
  - **Ask Anything** — a chat assistant for questions about motifs, tribes, ceremonies, and the HeriTech robot itself.
- **Voice input** — speak your chat questions using the browser's built-in speech recognition (Chrome/Edge; requires HTTPS or `localhost`).
- **Text-to-speech** — AI replies (and fun facts) are read aloud automatically in a natural, human-sounding voice (OpenAI `gpt-4o-mini-tts` via the backend), with per-message Replay/Stop controls.
- **Bahasa Malaysia toggle** — an EN/BM switch in the AI drawer header makes the assistant answer (and speak) entirely in Malay, voiced as a Malaysian woman.

## Tech stack

- **Frontend:** plain HTML/CSS/JavaScript, no build step, no framework (`index.html` + `script.js`).
- **Backend:** a small [Express](https://expressjs.com/) server (`server.js`) that proxies chat requests to the OpenAI API, so your API key never reaches the browser.
- **Robot link:** raw WebSocket to an ESP32 running Grbl (or compatible) firmware, listening on port `81`.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- An [OpenAI API key](https://platform.openai.com/api-keys) (only needed for the AI Guide — drawing, library, G-code, and robot-sending all work without it)

## Setup

1. **Clone and install dependencies**

   ```bash
   git clone https://github.com/philiplee2890/NRC2026.git
   cd NRC2026/HeriTech
   npm install
   ```

2. **Add your API key**

   Create a `.env` file in the same folder as `server.js`:

   ```
   OPENAI_API_KEY=sk-your-key-here
   ```

3. **Start the server**

   ```bash
   npm start
   ```

4. **Open the app**

   Visit **http://localhost:3000** in Chrome or Edge (needed for voice input; other browsers work fine for everything except the microphone).

   > Opening `index.html` directly as a file, or visiting via a different host (e.g. a Live Server extension on `127.0.0.1`), still works for drawing/library/G-code, but the AI Guide needs the page served from `http://localhost:3000` by `server.js` to reach its own backend.

## How to use it

### 1. Draw a motif

Switch the left panel to **Draw** mode, pick a tool (pen / line / eraser), a color, and a brush size. Turn on **Mirror** to sketch symmetric patterns in one pass. Use **Undo** or **Clear** as needed.

### 2. Save it to your Library

Click **Save to Library** on the canvas toolbar, give the motif a name, and it's stored locally so you can reload it any time from **Library** mode.

### 3. Generate G-code

Click **▶ Generate G-Code** in the right panel. The output preview updates with a highlighted, ready-to-run G-code program sized to the robot's 350×350mm work area. Use **Copy** or **⬇ .nc** to grab it.

### 4. Send it to the robot

Enter your ESP32's IP address (shown on its serial monitor / router client list) in the **Send to HeriTech** panel and click **▶ Send to HeriTech Robot**. The app opens a WebSocket to `ws://<ip>:81` and streams the program over line-by-line.

### 5. Ask the AI Guide

Click **🤖 Ask AI** in the header to open the drawer.

- **✨ Fun Facts** — click **New Fun Fact** for a fact about Orang Ulu culture; previous facts are kept below, and you can replay or stop the read-aloud for any of them.
- **💬 Ask Anything** — type a question, or tap 🎤 to speak it (Chrome/Edge only). Replies are read aloud automatically, with **🔊 Replay** / **⏹ Stop** buttons on every message.

If you see an "AI server unreachable" banner, make sure `server.js` is running and you're visiting the page through it (see the Setup note above).

## Project structure

```
HeriTech/
├── index.html      # markup + all styling
├── script.js        # app logic (canvas, library, G-code, robot link, AI guide)
├── server.js         # Express backend — proxies /api/chat and /api/tts to OpenAI
├── package.json
└── .env               # OPENAI_API_KEY (not committed)
```

## Notes

- Voice input and the microphone require a secure context (HTTPS or `localhost`) and a Chromium-based browser (Chrome/Edge) — the Web Speech API isn't available elsewhere. The app falls back gracefully to typed input everywhere else.
- Read-aloud replies require the backend to be reachable and `OPENAI_API_KEY` to be set — unlike voice input, it isn't a browser feature, so it needs the server running. Audio is streamed as Ogg/Opus for lower latency, which plays natively in Chrome/Edge/Firefox but not Safari.
- Each AI reply (chat and Fun Facts) has an EN/BM switch next to its Replay/Stop controls — click the other language to translate and re-speak that specific message in place, no page refresh needed. Translations are cached per-message so flipping back and forth is instant after the first switch.
- The Heritage Library is stored in your browser's `localStorage`, so it's per-browser/per-device, not synced anywhere.
- Decorative motifs in the UI are abstracted curvilinear line-work inspired by Orang Ulu carving and beadwork borders, not reproductions of specific figurative symbols (such as Aso/dragon-dog motifs), which carry rank and lineage significance in Kenyah/Kayan tradition.
