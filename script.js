// ============================================================
//  STATE
// ============================================================
let currentMode    = 'library';
let currentTool    = 'pen';
let currentColor   = '#000000';
let brushSize      = 3;
let isDrawing      = false;
let lastX = 0, lastY = 0;
let lineStartX = 0, lineStartY = 0;
let canvasHistory  = [];
let symmetryMode   = false;
let gcodeReady     = false;
let gcodeContent   = '';
let currentZoom    = 1;
let selectedLibId  = null;

// Vector path storage: array of strokes, each stroke is {color, size, points:[{x,y}], tool:'pen'|'line'}
let vectorStrokes  = [];
let currentStroke  = null;

const canvas = document.getElementById('mainCanvas');
const ctx    = canvas.getContext('2d');

// ============================================================
//  LIBRARY — localStorage persistence
// ============================================================
function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem('ulu_heritage_lib') || '[]');
  } catch { return []; }
}
function saveLibraryStore(lib) {
  localStorage.setItem('ulu_heritage_lib', JSON.stringify(lib));
}

function renderLibrarySidebar() {
  const lib = loadLibrary();
  const empty = document.getElementById('libEmpty');
  const grid  = document.getElementById('libGrid');

  if (lib.length === 0) {
    empty.style.display = 'flex';
    grid.style.display  = 'none';
    grid.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  grid.style.display  = 'grid';
  grid.innerHTML = '';

  lib.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'lib-card' + (entry.id === selectedLibId ? ' selected' : '');
    card.dataset.id = entry.id;
    card.onclick = () => loadFromLibrary(entry.id);

    // Thumbnail canvas
    const thumb = document.createElement('canvas');
    thumb.width  = 100;
    thumb.height = 100;
    const tc = thumb.getContext('2d');
    tc.fillStyle = '#fff';
    tc.fillRect(0,0,100,100);
    drawStrokesOnCtx(tc, entry.strokes, 100/500);
    card.appendChild(thumb);

    // Name label
    const name = document.createElement('div');
    name.className = 'lib-card-name';
    name.textContent = entry.name;
    card.appendChild(name);

    // Delete button
    const del = document.createElement('button');
    del.className = 'lib-card-del';
    del.textContent = '✕';
    del.title = 'Delete';
    del.onclick = (e) => {
      e.stopPropagation();
      deleteFromLibrary(entry.id);
    };
    card.appendChild(del);

    grid.appendChild(card);
  });
}

function deleteFromLibrary(id) {
  let lib = loadLibrary();
  lib = lib.filter(e => e.id !== id);
  saveLibraryStore(lib);
  if (selectedLibId === id) selectedLibId = null;
  renderLibrarySidebar();
  showToast('Motif removed from Library');
}

function loadFromLibrary(id) {
  const lib = loadLibrary();
  const entry = lib.find(e => e.id === id);
  if (!entry) return;
  selectedLibId = id;

  // Restore strokes
  vectorStrokes = entry.strokes.map(s => JSON.parse(JSON.stringify(s)));

  // Redraw canvas
  redrawFromStrokes();

  renderLibrarySidebar();
  document.getElementById('canvasHint').style.opacity = '0';
  document.getElementById('canvasInfo').textContent = `${entry.name} · ${vectorStrokes.length} stroke(s)`;

  // Reset gcode
  resetGCode();
  setStep(2);
  showToast(`Loaded: ${entry.name}`);
}

// ============================================================
//  SAVE TO LIBRARY
// ============================================================
function saveToLibrary() {
  if (vectorStrokes.length === 0) {
    showToast('Draw something first before saving');
    return;
  }
  // Show name prompt modal
  document.getElementById('modalIcon').textContent = '💾';
  document.getElementById('modalTitle').textContent = 'Save to Heritage Library';
  document.getElementById('modalMsg').textContent = 'Give this motif a name:';
  document.getElementById('modalInput').style.display = 'block';
  document.getElementById('modalInput').value = '';
  document.getElementById('modalInput').placeholder = 'e.g. Aso Motif';
  document.getElementById('modalConfirm').textContent = 'Save';
  document.getElementById('modalConfirm').onclick = () => {
    const name = document.getElementById('modalInput').value.trim() || 'Unnamed Motif';
    const lib  = loadLibrary();
    const entry = {
      id: 'motif_' + Date.now(),
      name,
      strokes: JSON.parse(JSON.stringify(vectorStrokes)),
      savedAt: new Date().toISOString()
    };
    lib.push(entry);
    saveLibraryStore(lib);
    closeModal();
    renderLibrarySidebar();
    setStep(2);
    showToast(`"${name}" saved to Library ✓`);
  };
  document.getElementById('modalOverlay').classList.add('show');
  setTimeout(() => document.getElementById('modalInput').focus(), 100);
}

// Enter key confirms modal
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('modalOverlay').classList.contains('show')) {
    document.getElementById('modalConfirm').click();
  }
  if (e.key === 'Escape') closeModal();
});

// ============================================================
//  INIT
// ============================================================
function init() {
  clearCanvasSilent();
  setupCanvasEvents();
  renderLibrarySidebar();
  bindUIEvents();
  setupVoiceControls();
  guardTutorialImages();
}

// ============================================================
//  UI EVENT BINDING — every button is wired here instead of
//  using inline onclick="" in the HTML. Inline handlers need a
//  global function of the same name to exist on `window`, which
//  silently breaks the moment a script has any module-loading
//  error (exactly what caused the "setMode is not defined" bug).
//  addEventListener has no such requirement, so this is safer.
// ============================================================
function bindUIEvents() {
  // Mode toggle
  document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Drawing tools
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  // Brush size
  document.getElementById('brushSize').addEventListener('input', e => updateBrushSize(e.target.value));

  // Color swatches
  document.querySelectorAll('.swatch[data-color]').forEach(swatch => {
    swatch.addEventListener('click', () => setColor(swatch.dataset.color, swatch));
  });

  // Undo / Clear / Mirror
  document.getElementById('undoBtn').addEventListener('click', undoCanvas);
  document.getElementById('clearBtn').addEventListener('click', clearCanvas);
  document.getElementById('mirrorBtn').addEventListener('click', toggleMirror);

  // Canvas toolbar
  document.getElementById('zoomInBtn').addEventListener('click', zoomIn);
  document.getElementById('zoomOutBtn').addEventListener('click', zoomOut);
  document.getElementById('saveToLibraryBtn').addEventListener('click', saveToLibrary);
  document.getElementById('exportSvgBtn').addEventListener('click', exportSVG);
  document.getElementById('resetBtn').addEventListener('click', confirmClear);

  // G-code panel
  document.getElementById('copyGcodeBtn').addEventListener('click', copyGCode);
  document.getElementById('downloadGcodeBtn').addEventListener('click', downloadGCode);
  document.getElementById('generateGcodeBtn').addEventListener('click', generateGCode);

  // Send to robot
  document.getElementById('sendBtn').addEventListener('click', sendToRobot);

  // Modal
  document.getElementById('modalCancelBtn').addEventListener('click', closeModal);

  // AI drawer
  document.getElementById('aiToggleBtn').addEventListener('click', toggleAiDrawer);
  document.getElementById('aiDrawerClose').addEventListener('click', toggleAiDrawer);
  document.getElementById('tabFunfact').addEventListener('click', () => switchAiTab('funfact'));
  document.getElementById('tabChat').addEventListener('click', () => switchAiTab('chat'));
  document.getElementById('funfactBtn').addEventListener('click', loadFunFact);
  document.getElementById('chatSendBtn').addEventListener('click', sendChat);
  document.getElementById('chatInput').addEventListener('keydown', chatKeydown);
  document.querySelectorAll('.chat-chip').forEach(chip => {
    chip.addEventListener('click', () => sendChip(chip));
  });
}

// Any tutorial screenshot that 404s (missing file) quietly turns
// into the same "coming soon" placeholder instead of a broken-image icon.
function guardTutorialImages() {
  document.querySelectorAll('.tutorial-img-slot img').forEach(img => {
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = 'slot-label';
      span.textContent = 'Screenshot coming soon';
      img.replaceWith(span);
    }, { once: true });
  });
}

// ============================================================
//  MODE SWITCHING
// ============================================================
function setMode(mode) {
  currentMode = mode;
  document.getElementById('modeLibBtn').classList.toggle('active', mode === 'library');
  document.getElementById('modeDrawBtn').classList.toggle('active', mode === 'draw');
  document.getElementById('libraryPanel').style.display   = mode === 'library' ? 'flex' : 'none';

  const dtp = document.getElementById('drawToolsPanel');
  dtp.style.display = mode === 'draw' ? 'flex' : 'none';
  dtp.style.flexDirection = 'column';

  const hint = document.getElementById('canvasHint');
  const info = document.getElementById('canvasInfo');

  if (mode === 'draw') {
    hint.style.opacity = vectorStrokes.length ? '0' : '1';
    hint.textContent = 'Draw freely — use tools on the left';
    info.textContent = `500 × 500 px · Draw mode`;
    canvas.style.cursor = 'crosshair';
  } else {
    hint.textContent = 'Switch to Draw mode to begin — or load a motif from the Library';
    hint.style.opacity = vectorStrokes.length ? '0' : '1';
    info.textContent = `500 × 500 px · Library mode`;
    canvas.style.cursor = 'default';
  }

  setStep(1);
}

// ============================================================
//  CANVAS DRAWING — VECTOR PATH STORAGE
// ============================================================
function setupCanvasEvents() {
  canvas.addEventListener('mousedown',  startDraw);
  canvas.addEventListener('mousemove',  draw);
  canvas.addEventListener('mouseup',    endDraw);
  canvas.addEventListener('mouseleave', endDraw);
  canvas.addEventListener('touchstart', e => { e.preventDefault(); startDraw(e.touches[0]); }, {passive:false});
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); draw(e.touches[0]);       }, {passive:false});
  canvas.addEventListener('touchend',   endDraw);
}

function getPos(e) {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width  / r.width;
  const sy = canvas.height / r.height;
  return [(e.clientX - r.left)*sx, (e.clientY - r.top)*sy];
}

function startDraw(e) {
  if (currentMode !== 'draw') return;
  const [x,y] = getPos(e);
  isDrawing = true;
  lastX = x; lastY = y;
  lineStartX = x; lineStartY = y;

  if (currentTool === 'eraser') {
    currentStroke = { tool:'eraser', color:'#FFFFFF', size: brushSize*4, points:[{x,y}] };
  } else if (currentTool === 'pen') {
    currentStroke = { tool:'pen', color:currentColor, size:brushSize, points:[{x,y}] };
  } else if (currentTool === 'line') {
    currentStroke = { tool:'line', color:currentColor, size:brushSize, points:[{x,y},{x,y}] };
  }

  saveHistory();
  document.getElementById('canvasHint').style.opacity = '0';
}

function draw(e) {
  if (!isDrawing || currentMode !== 'draw') return;
  const [x,y] = getPos(e);

  if (currentTool === 'line') {
    // Preview: redraw from strokes then draw live line
    redrawFromStrokes();
    ctx.beginPath();
    ctx.moveTo(lineStartX, lineStartY);
    ctx.lineTo(x, y);
    applyCtxStroke(currentColor, brushSize);
    if (symmetryMode) {
      ctx.beginPath();
      ctx.moveTo(canvas.width - lineStartX, lineStartY);
      ctx.lineTo(canvas.width - x, y);
      applyCtxStroke(currentColor, brushSize);
    }
    // Update endpoint in currentStroke for preview
    if (currentStroke) currentStroke.points[1] = {x,y};
  } else {
    // Pen / eraser — stream draw
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    if (currentTool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth   = brushSize * 4;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    } else {
      applyCtxStroke(currentColor, brushSize);
    }

    if (symmetryMode && currentTool !== 'eraser') {
      ctx.beginPath();
      ctx.moveTo(canvas.width-lastX, lastY);
      ctx.lineTo(canvas.width-x, y);
      applyCtxStroke(currentColor, brushSize);
    }

    if (currentStroke) currentStroke.points.push({x,y});
    lastX = x; lastY = y;
  }
}

function applyCtxStroke(color, size) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = color;
  ctx.lineWidth   = size;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.stroke();
}

function endDraw() {
  if (!isDrawing) return;
  isDrawing = false;

  if (currentStroke) {
    if (currentTool === 'line') {
      // Also save mirrored version as separate stroke
      vectorStrokes.push(JSON.parse(JSON.stringify(currentStroke)));
      if (symmetryMode) {
        const mirStroke = JSON.parse(JSON.stringify(currentStroke));
        mirStroke.points = mirStroke.points.map(p => ({x: canvas.width - p.x, y: p.y}));
        vectorStrokes.push(mirStroke);
      }
    } else if (currentStroke.points.length > 1) {
      vectorStrokes.push(JSON.parse(JSON.stringify(currentStroke)));
      if (symmetryMode && currentTool === 'pen') {
        const mirStroke = JSON.parse(JSON.stringify(currentStroke));
        mirStroke.points = mirStroke.points.map(p => ({x: canvas.width - p.x, y: p.y}));
        vectorStrokes.push(mirStroke);
      }
    }
    currentStroke = null;
  }

  saveHistory();
  document.getElementById('canvasInfo').textContent = `500 × 500 px · Draw mode · ${vectorStrokes.length} stroke(s)`;
}

// ============================================================
//  DRAW STROKES ONTO A CONTEXT (used for canvas & thumbnails)
// ============================================================
function drawStrokesOnCtx(c, strokes, scale=1) {
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  c.fillStyle = '#FFFFFF';
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);

  strokes.forEach(stroke => {
    if (!stroke.points || stroke.points.length < 2) return;
    c.beginPath();

    if (stroke.tool === 'eraser') {
      c.globalCompositeOperation = 'destination-out';
      c.strokeStyle = 'rgba(0,0,0,1)';
      c.lineWidth   = stroke.size * scale;
    } else {
      c.globalCompositeOperation = 'source-over';
      c.strokeStyle = stroke.color;
      c.lineWidth   = stroke.size * scale;
    }
    c.lineCap = c.lineJoin = 'round';

    if (stroke.tool === 'line') {
      c.moveTo(stroke.points[0].x * scale, stroke.points[0].y * scale);
      c.lineTo(stroke.points[1].x * scale, stroke.points[1].y * scale);
    } else {
      c.moveTo(stroke.points[0].x * scale, stroke.points[0].y * scale);
      for (let i=1; i<stroke.points.length; i++) {
        c.lineTo(stroke.points[i].x * scale, stroke.points[i].y * scale);
      }
    }
    c.stroke();
    c.globalCompositeOperation = 'source-over';
  });
}

function redrawFromStrokes() {
  drawStrokesOnCtx(ctx, vectorStrokes, 1);
}

// ============================================================
//  TOOLS
// ============================================================
function setTool(t) {
  currentTool = t;
  ['Pen','Line','Eraser'].forEach(id => {
    document.getElementById('tool'+id).classList.remove('active');
  });
  document.getElementById('tool' + t.charAt(0).toUpperCase() + t.slice(1)).classList.add('active');
  canvas.style.cursor = t === 'eraser' ? 'cell' : 'crosshair';
}

function setColor(c, el) {
  currentColor = c;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  if (currentTool === 'eraser') setTool('pen');
}

function updateBrushSize(v) {
  brushSize = parseInt(v);
  document.getElementById('brushSizeVal').textContent = v;
}

function toggleMirror() {
  symmetryMode = !symmetryMode;
  const btn = document.getElementById('mirrorBtn');
  btn.classList.toggle('active', symmetryMode);
  showToast(symmetryMode ? 'Mirror symmetry ON' : 'Mirror symmetry OFF');
}

// ============================================================
//  CANVAS HISTORY (for Undo)
// ============================================================
function saveHistory() {
  // Store a deep copy of vectorStrokes
  canvasHistory.push(JSON.parse(JSON.stringify(vectorStrokes)));
  if (canvasHistory.length > 40) canvasHistory.shift();
}

function undoCanvas() {
  if (canvasHistory.length < 2) { showToast('Nothing to undo'); return; }
  canvasHistory.pop(); // remove current state
  vectorStrokes = JSON.parse(JSON.stringify(canvasHistory[canvasHistory.length - 1]));
  redrawFromStrokes();
  document.getElementById('canvasInfo').textContent = `500 × 500 px · Draw mode · ${vectorStrokes.length} stroke(s)`;
}

function clearCanvas() {
  vectorStrokes = [];
  clearCanvasSilent();
  saveHistory();
  resetGCode();
  document.getElementById('canvasHint').style.opacity = '1';
  document.getElementById('canvasInfo').textContent = '500 × 500 px · Draw mode';
}

function clearCanvasSilent() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function confirmClear() {
  document.getElementById('modalIcon').textContent = '⚠️';
  document.getElementById('modalTitle').textContent = 'Reset Canvas';
  document.getElementById('modalMsg').textContent = 'This will clear all strokes. Are you sure?';
  document.getElementById('modalInput').style.display = 'none';
  document.getElementById('modalConfirm').textContent = 'Clear';
  document.getElementById('modalConfirm').onclick = () => { clearCanvas(); closeModal(); };
  document.getElementById('modalOverlay').classList.add('show');
}

// ============================================================
//  ZOOM
// ============================================================
function zoomIn()  { currentZoom = Math.min(currentZoom+0.15, 2.5); canvas.style.transform = `scale(${currentZoom})`; }
function zoomOut() { currentZoom = Math.max(currentZoom-0.15, 0.4); canvas.style.transform = `scale(${currentZoom})`; }

// ============================================================
//  TRUE VECTOR SVG EXPORT
// ============================================================
function exportSVG() {
  if (vectorStrokes.length === 0) { showToast('Draw something first'); return; }

  let pathElements = '';
  vectorStrokes.forEach(stroke => {
    if (!stroke.points || stroke.points.length < 2) return;

    const color = stroke.tool === 'eraser' ? 'none' : stroke.color;
    const w     = stroke.size;

    if (stroke.tool === 'line') {
      const p0 = stroke.points[0];
      const p1 = stroke.points[1];
      pathElements += `  <line x1="${p0.x.toFixed(2)}" y1="${p0.y.toFixed(2)}" x2="${p1.x.toFixed(2)}" y2="${p1.y.toFixed(2)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>\n`;
    } else if (stroke.tool === 'eraser') {
      // Erasers represented as white polyline
      const pts = stroke.points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      pathElements += `  <polyline points="${pts}" stroke="#FFFFFF" stroke-width="${stroke.size*4}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>\n`;
    } else {
      // Pen stroke: build smooth polyline
      const pts = stroke.points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      pathElements += `  <polyline points="${pts}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>\n`;
    }
  });

  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="500" height="500" viewBox="0 0 500 500">
  <!-- HeriTech Pattern Studio — True Vector Export -->
  <!-- Generated: ${new Date().toISOString()} -->
  <!-- Strokes: ${vectorStrokes.length} -->
  <!-- Compatible with svg2gcode tools -->
  <rect width="500" height="500" fill="white"/>
${pathElements}</svg>`;

  download('heritech_pattern.svg', svgContent, 'image/svg+xml');
  showToast('True vector SVG exported — ready for svg2gcode ✓');
}

// ============================================================
//  G-CODE GENERATION — from vector strokes
// ============================================================
function generateGCode() {
  if (vectorStrokes.length === 0) {
    showToast('Draw a pattern first'); return;
  }

  const fabricW = 350, fabricH = 350; // HeriTech work area mm
  const scaleX  = fabricW / canvas.width;
  const scaleY  = fabricH / canvas.height;

  let lines = [];
  lines.push(`; ============================================`);
  lines.push(`; HeriTech Pattern Studio — G-Code Output`);
  lines.push(`; Generated: ${new Date().toLocaleString()}`);
  lines.push(`; Work area: ${fabricW}x${fabricH}mm`);
  lines.push(`; Strokes: ${vectorStrokes.length}`);
  lines.push(`; Machine: HeriTech XY Plotter (Grbl/ESP32)`);
  lines.push(`; ============================================`);
  lines.push(``);
  lines.push(`G21        ; millimeter units`);
  lines.push(`G90        ; absolute positioning`);
  lines.push(`G28        ; home all axes`);
  lines.push(`M3 S0      ; chalk wheel up`);
  lines.push(`F800       ; feed rate 800 mm/min`);
  lines.push(``);
  lines.push(`; --- Begin pattern ---`);

  vectorStrokes.forEach((stroke, i) => {
    if (!stroke.points || stroke.points.length < 2) return;
    if (stroke.tool === 'eraser') return; // skip erasers in gcode

    lines.push(``);
    lines.push(`; Stroke ${i+1} (${stroke.tool})`);

    const pts = stroke.tool === 'line'
      ? [stroke.points[0], stroke.points[1]]
      : stroke.points;

    // Move to start
    const sx = (pts[0].x * scaleX).toFixed(2);
    const sy = (pts[0].y * scaleY).toFixed(2);
    lines.push(`G0 X${sx} Y${sy}`);
    lines.push(`M3 S255    ; lower chalk`);

    // Draw through points (downsample pen strokes to reduce file size)
    const step = stroke.tool === 'pen' ? Math.max(1, Math.floor(pts.length/60)) : 1;
    for (let j = step; j < pts.length; j += step) {
      const gx = (pts[j].x * scaleX).toFixed(2);
      const gy = (pts[j].y * scaleY).toFixed(2);
      lines.push(`G1 X${gx} Y${gy}`);
    }
    // Ensure last point
    const ex = (pts[pts.length-1].x * scaleX).toFixed(2);
    const ey = (pts[pts.length-1].y * scaleY).toFixed(2);
    lines.push(`G1 X${ex} Y${ey}`);
    lines.push(`M5 S0      ; lift chalk`);
  });

  lines.push(``);
  lines.push(`; --- End pattern ---`);
  lines.push(`G0 X0 Y0   ; return home`);
  lines.push(`M2         ; end program`);

  gcodeContent = lines.join('\n');
  gcodeReady   = true;

  const highlighted = lines.map(l => {
    if (l.startsWith(';') || l === '') return `<span class="gcode-line-comment">${escHtml(l)}</span>`;
    if (l.startsWith('G0') || l.startsWith('G1')) return `<span class="gcode-line-move">${escHtml(l)}</span>`;
    return `<span class="gcode-line-cmd">${escHtml(l)}</span>`;
  }).join('<br>');

  document.getElementById('gcodeBox').innerHTML = highlighted;
  document.getElementById('sendBtn').disabled = false;
  document.getElementById('sendStatus').textContent = `${lines.length} lines ready — enter ESP32 IP and send.`;
  setStep(3);
  showToast(`G-code generated — ${lines.length} lines ✓`);
}

function resetGCode() {
  gcodeReady   = false;
  gcodeContent = '';
  document.getElementById('gcodeBox').innerHTML = `
    <span class="gcode-line-comment">; G-code will appear here after generation.</span><br><br>
    <span class="gcode-line-comment">; 1. Draw or load a motif</span><br>
    <span class="gcode-line-comment">; 2. Click Generate G-Code</span><br>
    <span class="gcode-line-comment">; 3. Send to ESP32 HeriTech</span>`;
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('sendStatus').textContent = 'Generate G-code first, then send.';
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function copyGCode() {
  if (!gcodeContent) { showToast('Generate G-code first'); return; }
  navigator.clipboard.writeText(gcodeContent).then(() => showToast('G-code copied to clipboard ✓'));
}

function downloadGCode() {
  if (!gcodeContent) { showToast('Generate G-code first'); return; }
  download('heritech_pattern.nc', gcodeContent, 'text/plain');
  showToast('G-code .nc file downloaded ✓');
}

// ============================================================
//  SEND TO ROBOT (WebSocket to ESP32 Grbl)
// ============================================================
async function sendToRobot() {
  if (!gcodeReady) { showToast('Generate G-code first'); return; }
  const ip = document.getElementById('espIpInput').value.trim();
  if (!ip)  { showToast('Enter ESP32 IP address'); return; }

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  document.getElementById('sendStatus').textContent = 'Connecting to ESP32…';

  try {
    const ws = new WebSocket(`ws://${ip}:81`);
    const gcodeLines = gcodeContent.split('\n').filter(l => l.trim() && !l.startsWith(';'));

    ws.onopen = () => {
      btn.textContent = 'Sending…';
      document.getElementById('sendStatus').textContent = `Connected — sending ${gcodeLines.length} lines…`;
      setStep(4);
      let i = 0;
      const sendNext = () => {
        if (i >= gcodeLines.length) {
          document.getElementById('sendStatus').textContent = `✓ All ${gcodeLines.length} lines sent successfully`;
          btn.textContent = '✓ Sent';
          showToast('G-code sent to robot! ✓');
          ws.close();
          return;
        }
        ws.send(gcodeLines[i] + '\n');
        document.getElementById('sendStatus').textContent = `Sending line ${i+1}/${gcodeLines.length}…`;
        i++;
        setTimeout(sendNext, 20);
      };
      setTimeout(sendNext, 500);
    };
    ws.onerror = () => {
      document.getElementById('sendStatus').textContent = '⚠ Could not connect — check IP and network';
      btn.textContent = '▶ Send to HeriTech Robot';
      btn.disabled = false;
      showToast('Connection failed — is the ESP32 online?');
    };
  } catch(err) {
    document.getElementById('sendStatus').textContent = 'Error: ' + err.message;
    btn.textContent = '▶ Send to HeriTech Robot';
    btn.disabled = false;
  }
}

// ============================================================
//  STEP INDICATOR
// ============================================================
function setStep(n) {
  for (let i=1; i<=4; i++) {
    document.getElementById('step'+i).classList.toggle('active', i===n);
  }
}

// ============================================================
//  UTILITIES
// ============================================================
function download(filename, content, type) {
  const blob = new Blob([content], {type});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
}

// ============================================================
//  TUTORIAL POPUP
// ============================================================
const TUTORIAL_PAGES = 6;
let tCur = 0;

function buildTutorialDots() {
  const dotsEl = document.getElementById('tutorialDots');
  for (let i = 0; i < TUTORIAL_PAGES; i++) {
    const d = document.createElement('div');
    d.className = 't-dot' + (i === 0 ? ' active' : '');
    d.onclick = () => tutorialGoTo(i);
    dotsEl.appendChild(d);
  }
}

function tutorialGoTo(n) {
  if (n < 0 || n >= TUTORIAL_PAGES) return;
  tCur = n;
  document.getElementById('tutorialTrack').style.transform = `translateX(-${tCur * 100}%)`;
  document.querySelectorAll('.t-dot').forEach((d, i) => d.classList.toggle('active', i === tCur));
  document.getElementById('tutorialPrev').disabled = (tCur === 0);
  document.getElementById('tutorialNext').classList.toggle('hidden', tCur === TUTORIAL_PAGES - 1);
  document.getElementById('tutorialSkip').classList.toggle('show', tCur === TUTORIAL_PAGES - 1);
}

function closeTutorial() {
  const modal   = document.getElementById('tutorialModal');
  const overlay = document.getElementById('tutorialOverlay');
  const target  = document.getElementById('tutorialReopen');

  const modalRect  = modal.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();

  const dx = (targetRect.left + targetRect.width / 2)  - (modalRect.left + modalRect.width / 2);
  const dy = (targetRect.top  + targetRect.height / 2) - (modalRect.top  + modalRect.height / 2);
  const scale = targetRect.width / modalRect.width;

  modal.style.transition = 'transform 0.55s cubic-bezier(.4,0,.2,1), opacity 0.55s';
  modal.style.transform  = `translate(${dx}px, ${dy}px) scale(${scale})`;
  modal.style.opacity    = '0';

  setTimeout(() => {
    overlay.classList.remove('show');
    modal.style.transition = '';
    modal.style.transform  = '';
    modal.style.opacity    = '';
    target.classList.add('show');
  }, 550);
}

function openTutorial() {
  const modal   = document.getElementById('tutorialModal');
  const overlay = document.getElementById('tutorialOverlay');
  const target  = document.getElementById('tutorialReopen');

  const targetRect = target.getBoundingClientRect();
  target.classList.remove('show');
  overlay.classList.add('show');

  const modalRect = modal.getBoundingClientRect();
  const dx = (targetRect.left + targetRect.width / 2)  - (modalRect.left + modalRect.width / 2);
  const dy = (targetRect.top  + targetRect.height / 2) - (modalRect.top  + modalRect.height / 2);
  const scale = targetRect.width / modalRect.width;

  modal.style.transition = 'none';
  modal.style.transform  = `translate(${dx}px, ${dy}px) scale(${scale})`;
  modal.style.opacity    = '0';
  void modal.offsetWidth; // force reflow
  modal.style.transition = 'transform 0.5s cubic-bezier(.4,0,.2,1), opacity 0.5s';
  modal.style.transform  = 'translate(0,0) scale(1)';
  modal.style.opacity    = '1';
}

// ============================================================
//  AI ASSISTANT — talks to OUR OWN backend, never to the AI
//  provider directly. The backend (server.js) holds the secret
//  GitHub token and calls GitHub Models server-side. This file
//  never sees the token, so it's safe even though this code is
//  public. See SETUP.md for how to run the backend.
// ============================================================
let aiLoading      = false;
let funfactHistory = [];
let chatHistory    = [];
let speechRecognition = null;
let isListening = false;
let lastVoiceTranscript = '';
let voiceFallbackMode = false;

// Recognizes any way of running the frontend locally — plain
// 'localhost', '127.0.0.1'/'::1' (e.g. VS Code Live Server, which
// defaults to 127.0.0.1), or index.html opened directly as a file
// (empty hostname). Previously only the literal string 'localhost'
// matched, so anything else silently fell through to the template
// author's own hosted backend instead of the local one.
function isLocalDev() {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '' || window.location.protocol === 'file:';
}

async function callAI(systemPrompt, messages) {
  const BACKEND_URL = isLocalDev()
    ? 'http://localhost:3000/api/chat'
    : 'https://heri-tech.vercel.app/api/chat';

  const response = await fetch(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: systemPrompt, messages })
  });

  if (!response.ok) {
    let msg = `Server error (${response.status})`;
    try {
      const err = await response.json();
      if (err.error) msg = err.error;
    } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  return data.reply || '';
}

function showAiOffline(show) {
  document.getElementById('aiOfflineBanner').classList.toggle('show', !!show);
}

// ============================================================
//  TEXT-TO-SPEECH (TTS) MODULE — standalone from the mic/STT
//  code below. Anything that wants to read text aloud calls
//  speakText(text); anything that wants to interrupt it calls
//  stopSpeaking(). Each AI chat bubble AND the Fun Fact card get
//  their own Replay/Stop pair (see buildTtsControls) so any past
//  reply or fact can be re-read, not just the most recent one.
// ============================================================
let isSpeaking = false;

function ttsSupported() {
  return 'speechSynthesis' in window;
}

function speakText(text) {
  if (!text || !ttsSupported()) return;
  window.speechSynthesis.cancel(); // interrupt whatever is currently playing

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'en-US';
  utter.rate = 1.0;

  utter.onstart = () => { isSpeaking = true;  updateTtsButtons(); };
  utter.onend   = () => { isSpeaking = false; updateTtsButtons(); };
  utter.onerror = () => {
    isSpeaking = false;
    updateTtsButtons();
    setVoiceStatus('Voice readout failed. See console for details.');
  };

  window.speechSynthesis.speak(utter);
}

function stopSpeaking() {
  if (!ttsSupported()) return;
  window.speechSynthesis.cancel();
  isSpeaking = false;
  updateTtsButtons();
}

// Keeps every Replay/Stop button — in chat bubbles AND the Fun Fact
// card — in sync with playback state, since speechSynthesis only
// ever plays one utterance at a time regardless of which one
// triggered it.
function updateTtsButtons() {
  document.querySelectorAll('.tts-replay').forEach(b => b.disabled = !ttsSupported());
  document.querySelectorAll('.tts-stop').forEach(b => b.disabled = !isSpeaking);
}


function setVoiceStatus(message) {
  const el = document.getElementById('chatVoiceStatus');
  if (!el) return;
  el.textContent = message;

  // small visual feedback even if styles don't exist
  el.style.opacity = '1';
  el.style.transform = 'translateY(0)';
}


async function ensureMicrophoneAccess() {
  if (!window.isSecureContext) {
    setVoiceStatus('Voice input needs HTTPS (or localhost) to access the microphone.');
    return false;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setVoiceStatus('Microphone access is not available in this browser.');
    return false;
  }

  try {
    setVoiceStatus('Requesting microphone access...');
    // This call exists only to trigger the permission prompt and get a
    // specific error name (NotAllowedError / NotFoundError) up front.
    // SpeechRecognition captures its own audio internally, so the stream
    // is released immediately rather than held open — keeping it open
    // caused SpeechRecognition's own mic request to conflict on some
    // browsers/drivers ("microphone is busy" even on first use).
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch (error) {
    let message = 'Microphone permission was denied.';
    if (error.name === 'NotAllowedError') {
      message = 'Please allow microphone access for this site.';
    } else if (error.name === 'NotFoundError') {
      message = 'No microphone was found on this device.';
    }
    setVoiceStatus(message);
    return false;
  }
}

function fallbackVoiceInput() {
  voiceFallbackMode = true;
  const input = document.getElementById('chatInput');
  const message = !window.isSecureContext
    ? 'Voice input needs HTTPS (or localhost) here. You can still type your question below.'
    : 'Voice input is not supported in this browser. You can still type your question below.';
  setVoiceStatus(message);
  if (input) {
    input.focus();
    input.placeholder = 'Type your question here instead...';
  }
}

async function toggleVoiceInput() {
  if (!speechRecognition) {
    fallbackVoiceInput();
    return;
  }

  if (isListening) {
    speechRecognition.stop();
    return;
  }

  lastVoiceTranscript = '';
  document.getElementById('chatInput').value = '';

  const granted = await ensureMicrophoneAccess();
  if (!granted) {
    fallbackVoiceInput();
    return;
  }

  try {
    setVoiceStatus('Listening... speak now.');
    speechRecognition.start();
  } catch {
    setVoiceStatus('Microphone is busy. Please try again.');
  }
}

function setupVoiceControls() {
  const voiceBtn = document.getElementById('chatVoiceBtn');
  const stopBtn = document.getElementById('chatStopBtn');
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!voiceBtn || !stopBtn) return;

  stopBtn.disabled = true;

  // Unsupported browser (e.g. Firefox/Safari) or insecure context
  // (mic access requires HTTPS or localhost). Bind the click handler
  // to fallbackVoiceInput() rather than returning early — previously
  // the listener was never attached in this branch, so the button
  // silently did nothing on every click after the first page load.
  if (!SpeechRecognitionCtor || !window.isSecureContext) {
    voiceBtn.addEventListener('click', fallbackVoiceInput);
    fallbackVoiceInput();
    return;
  }

  speechRecognition = new SpeechRecognitionCtor();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-US';

  speechRecognition.onstart = () => {
    isListening = true;
    voiceBtn.classList.add('listening');
    voiceBtn.title = 'Listening...';
    stopBtn.disabled = false;
    setVoiceStatus('Listening... speak now.');
  };

  speechRecognition.onresult = (event) => {
    let interim = '';
    let finalText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal) {
        finalText += (finalText ? ' ' : '') + transcript;
      } else {
        interim += (interim ? ' ' : '') + transcript;
      }
    }

    if (finalText) {
      lastVoiceTranscript = finalText;
      document.getElementById('chatInput').value = lastVoiceTranscript;
      setVoiceStatus('Voice captured. Sending your question...');
      window.setTimeout(() => {
        if (document.getElementById('chatInput').value.trim()) {
          sendChat();
        }
      }, 350);
    } else {
      document.getElementById('chatInput').value = interim;
      setVoiceStatus('Listening...');
    }
  };

  speechRecognition.onerror = (event) => {
    isListening = false;
    voiceBtn.classList.remove('listening');
    stopBtn.disabled = true;
    const errorMessage = event.error === 'not-allowed'
      ? 'Please allow microphone access for this site.'
      : `Voice error: ${event.error}`;
    setVoiceStatus(errorMessage);
  };

  speechRecognition.onend = () => {
    isListening = false;
    voiceBtn.classList.remove('listening');
    stopBtn.disabled = true;
    if (lastVoiceTranscript.trim()) {
      setVoiceStatus('Voice captured.');
    } else {
      setVoiceStatus('Tap the mic and speak your question.');
    }
    voiceBtn.title = 'Speak your question';
  };

  voiceBtn.addEventListener('click', toggleVoiceInput);
  stopBtn.addEventListener('click', () => {
    if (speechRecognition && isListening) {
      speechRecognition.stop();
    }
  });
}

function toggleAiDrawer() {
  document.getElementById('aiDrawer').classList.toggle('open');
}

function switchAiTab(tab) {
  document.getElementById('tabFunfact').classList.toggle('active', tab === 'funfact');
  document.getElementById('tabChat').classList.toggle('active',    tab === 'chat');
  document.getElementById('panelFunfact').classList.toggle('active', tab === 'funfact');
  document.getElementById('panelChat').classList.toggle('active',    tab === 'chat');
}

// ---- FUN FACT ----
async function loadFunFact() {
  if (aiLoading) return;
  aiLoading = true;

  const btn  = document.getElementById('funfactBtn');
  const card = document.getElementById('funfactCard');
  btn.disabled = true;
  btn.textContent = '⏳ Loading...';
  card.innerHTML = '<div class="funfact-badge">★ Orang Ulu Fun Fact</div>' +
    '<div class="funfact-loading" style="margin-top:20px">' +
    '<div class="dot-spin"><span></span><span></span><span></span></div>' +
    'Discovering something fascinating…</div>';

  try {
    const avoid = funfactHistory.length
      ? 'Do not repeat these topics: ' + funfactHistory.slice(-5).join(', ') + '.'
      : '';
    const text = await callAI(
      'You are a cultural expert on the Orang Ulu people of Sarawak, Malaysia. ' +
      'Share fascinating, surprising, and specific fun facts about their culture, beadwork motifs, traditions, ceremonies, music, or history. ' +
      'Keep each fact to 2–3 sentences. Be specific and vivid. ' + avoid,
      [{ role: 'user', content: 'Give me one fun fact about Orang Ulu culture. Start directly with the fact — no preamble.' }]
    );
    showAiOffline(false);
    if (text) {
      const prevText = document.getElementById('funfactText')?.textContent;
      if (prevText && !prevText.includes('Click the button')) {
        funfactHistory.push(prevText);
        renderFunfactHistory();
      }
      renderFunfactCard(text);
      speakText(text);
    }
  } catch (e) {
    card.innerHTML = '<div class="funfact-badge">★ Error</div>' +
      '<div class="funfact-text" style="color:var(--crimson)">Could not load fun fact: ' + escHtml(e.message) + '</div>';
    showAiOffline(true);
  }
  aiLoading = false;
  btn.disabled = false;
  btn.textContent = '✨ New Fun Fact';
}

// Renders a successful fact into the card with its own Replay/Stop
// controls, so a previously-heard fact can be replayed on demand
// (mirrors buildTtsControls' use in the chat panel).
function renderFunfactCard(text) {
  const card = document.getElementById('funfactCard');
  card.innerHTML = '';

  const badge = document.createElement('div');
  badge.className = 'funfact-badge';
  badge.textContent = '★ Orang Ulu Fun Fact';
  card.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'funfact-text';
  body.id = 'funfactText';
  body.textContent = text;
  card.appendChild(body);

  card.appendChild(buildTtsControls(text));
}

function renderFunfactHistory() {
  const area = document.getElementById('funfactHistory');
  if (!funfactHistory.length) { area.innerHTML = ''; return; }
  area.innerHTML = '<div class="funfact-history-label">Previous facts</div>' +
    funfactHistory.slice().reverse().slice(0,4).map(f =>
      '<div class="funfact-prev">' + escHtml(f) + '</div>'
    ).join('');
}

// ---- CHAT ----
function appendChatMsg(role, text) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;

  const label = document.createElement('div');
  label.className = 'chat-msg-label';
  label.textContent = role === 'user' ? 'You' : 'HeriTech AI';
  div.appendChild(label);

  const body = document.createElement('div');
  body.className = 'chat-msg-text';
  body.textContent = text;
  div.appendChild(body);

  // Only finished AI replies get playback controls — user bubbles and
  // the "thinking…" placeholder don't need them.
  if (role === 'ai' && text) {
    div.appendChild(buildTtsControls(text));
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// Builds a Replay/Stop button pair wired to speak `text`. Shared by
// chat bubbles (appendChatMsg) and the Fun Fact card (loadFunFact).
function buildTtsControls(text) {
  const controls = document.createElement('div');
  controls.className = 'tts-controls';

  const replayBtn = document.createElement('button');
  replayBtn.className = 'tts-btn tts-replay';
  replayBtn.textContent = '🔊 Replay';
  replayBtn.disabled = !ttsSupported();
  replayBtn.addEventListener('click', () => speakText(text));

  const stopBtn = document.createElement('button');
  stopBtn.className = 'tts-btn tts-stop';
  stopBtn.textContent = '⏹ Stop';
  stopBtn.disabled = !isSpeaking;
  stopBtn.addEventListener('click', stopSpeaking);

  controls.appendChild(replayBtn);
  controls.appendChild(stopBtn);
  return controls;
}

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function sendChip(el) {
  document.getElementById('chatInput').value = el.textContent;
  sendChat();
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const msg   = input.value.trim();
  if (!msg || aiLoading) return;

  input.value = '';
  aiLoading   = true;
  document.getElementById('chatSendBtn').disabled = true;

  appendChatMsg('user', msg);
  chatHistory.push({ role: 'user', content: msg });

  const thinking = document.createElement('div');
  thinking.className = 'chat-msg ai thinking';
  thinking.innerHTML = '<div class="chat-msg-label">HeriTech AI</div>' +
    '<div class="dot-spin"><span></span><span></span><span></span></div>';
  document.getElementById('chatMessages').appendChild(thinking);
  document.getElementById('chatMessages').scrollTop = 9999;

  try {
    const history = chatHistory.slice(-8);
    const reply = await callAI(
      'You are HeriTech AI, a friendly and knowledgeable cultural expert on the Orang Ulu people of Sarawak, Malaysia. ' +
      'You specialise in their beadwork traditions, motifs, ceremonies, music (especially the Sape), language, and cultural heritage. ' +
      'You also know about the HeriTech robot — an XY plotter that automates traditional beadwork production. ' +
      'Answer concisely (3–5 sentences max). Be warm, engaging, and culturally respectful. ' +
      'If asked about non-Orang Ulu topics, gently redirect to cultural or heritage topics.',
      history
    );
    thinking.remove();
    showAiOffline(false);
    chatHistory.push({ role: 'assistant', content: reply });
    const replyText = reply || 'Sorry, I could not generate a response.';
    appendChatMsg('ai', replyText);
    speakText(replyText);
  } catch (e) {
    thinking.remove();
    appendChatMsg('ai', '⚠ Error: ' + e.message);
    showAiOffline(true);
  }

  aiLoading = false;
  document.getElementById('chatSendBtn').disabled = false;
  document.getElementById('chatMessages').scrollTop = 9999;
}

function setupTutorial() {
  buildTutorialDots();
  tutorialGoTo(0);

  document.getElementById('tutorialPrev').onclick = () => tutorialGoTo(tCur - 1);
  document.getElementById('tutorialNext').onclick = () => tutorialGoTo(tCur + 1);
  document.getElementById('tutorialSkip').onclick = closeTutorial;
  document.getElementById('tutorialClose').onclick = closeTutorial;
  document.getElementById('tutorialReopen').onclick = openTutorial;

  // Swipe support
  let tx = 0;
  const track = document.getElementById('tutorialTrack');
  track.addEventListener('touchstart', e => { tx = e.touches[0].clientX; });
  track.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 50) tutorialGoTo(tCur + (dx < 0 ? 1 : -1));
  });

  // Auto-show on page load
  document.getElementById('tutorialOverlay').classList.add('show');
}

setupTutorial();
init();