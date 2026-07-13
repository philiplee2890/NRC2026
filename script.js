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
function saveToLibrary(suggestedName) {
  if (vectorStrokes.length === 0) {
    showToast('Draw something first before saving');
    return;
  }
  // Show name prompt modal
  document.getElementById('modalIcon').textContent = '💾';
  document.getElementById('modalTitle').textContent = 'Save to Heritage Library';
  document.getElementById('modalMsg').textContent = 'Give this motif a name:';
  document.getElementById('modalInput').style.display = 'block';
  document.getElementById('modalInput').value = suggestedName || '';
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
  setTimeout(() => document.getElementById('modalInput').select(), 100);
}

// ============================================================
//  IMPORT SVG — loads an uploaded .svg file onto the canvas as
//  vectorStrokes, then opens the same "Save to Library" modal
//  saveToLibrary() already uses for hand-drawn motifs, pre-filled
//  with the file's name.
// ============================================================
function importSvgFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let strokes;
    try {
      strokes = parseSvgToStrokes(reader.result);
    } catch (e) {
      showToast('Could not import SVG: ' + e.message);
      return;
    }
    if (!strokes.length) {
      showToast('No drawable shapes found in that SVG');
      return;
    }

    setMode('draw');
    vectorStrokes = strokes;
    redrawFromStrokes();
    saveHistory();
    resetGCode();
    document.getElementById('canvasHint').style.opacity = '0';
    document.getElementById('canvasInfo').textContent = `Imported · ${vectorStrokes.length} stroke(s)`;

    const suggestedName = file.name.replace(/\.svg$/i, '') || 'Imported Motif';
    showToast(`Imported "${file.name}" ✓ — name it to save`);
    saveToLibrary(suggestedName);
  };
  reader.onerror = () => showToast('Could not read that file');
  reader.readAsText(file);
}

// Converts an SVG file's drawable shapes (path, line, polyline,
// polygon, circle, ellipse, rect) into vectorStrokes-format pen
// strokes, fit and centered into the 500x500 working canvas.
//
// Rather than hand-parsing path/arc/bezier syntax, this leans on the
// browser's native SVGGeometryElement API (getTotalLength /
// getPointAtLength), which every one of those element types supports —
// so curves of any kind are sampled correctly for free. The element
// has to be attached to the live document for that API (and
// getComputedStyle, for resolving CSS/style-block colors) to work,
// hence the temporary off-screen append/remove.
function parseSvgToStrokes(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid SVG file');

  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') throw new Error('File is not an SVG');

  let srcX = 0, srcY = 0, srcW, srcH;
  const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox.every(n => !isNaN(n))) {
    [srcX, srcY, srcW, srcH] = viewBox;
  } else {
    srcW = parseFloat(root.getAttribute('width'))  || 500;
    srcH = parseFloat(root.getAttribute('height')) || 500;
  }
  if (!srcW || !srcH) { srcW = 500; srcH = 500; }

  const CANVAS = 500;
  const fitScale = Math.min(CANVAS / srcW, CANVAS / srcH);
  const offsetX  = (CANVAS - srcW * fitScale) / 2;
  const offsetY  = (CANVAS - srcH * fitScale) / 2;
  const mapPoint = (x, y) => ({
    x: (x - srcX) * fitScale + offsetX,
    y: (y - srcY) * fitScale + offsetY
  });

  const liveRoot = document.importNode(root, true);
  liveRoot.style.position = 'absolute';
  liveRoot.style.left = '-99999px';
  liveRoot.style.top  = '-99999px';
  document.body.appendChild(liveRoot);

  const strokes = [];
  try {
    const shapes = Array.from(liveRoot.querySelectorAll('path, line, polyline, polygon, circle, ellipse, rect')).slice(0, 400);

    shapes.forEach(el => {
      if (typeof el.getTotalLength !== 'function') return;
      let length;
      try { length = el.getTotalLength(); } catch { return; }
      if (!length || !isFinite(length)) return;

      const ctm = el.getCTM();
      const computed = window.getComputedStyle(el);
      let color = el.getAttribute('stroke') || computed.stroke;
      if (!color || color === 'none') color = el.getAttribute('fill') || computed.fill;
      if (!color || color === 'none') color = '#000000';

      const rawWidth = parseFloat(el.getAttribute('stroke-width') || computed.strokeWidth) || 2;
      const size = Math.min(Math.max(rawWidth * fitScale, 1), 20);

      const sampleCount = Math.min(300, Math.max(2, Math.round(length / 2)));
      const points = [];
      for (let i = 0; i <= sampleCount; i++) {
        let pt = el.getPointAtLength((i / sampleCount) * length);
        if (ctm) pt = pt.matrixTransform(ctm);
        points.push(mapPoint(pt.x, pt.y));
      }

      strokes.push({ color, size, points, tool: 'pen' });
    });
  } finally {
    document.body.removeChild(liveRoot);
  }

  return strokes;
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

  // Custom color picker + hex input
  const colorPicker = document.getElementById('colorPicker');
  const hexInput = document.getElementById('hexInput');
  colorPicker.addEventListener('input', () => setColor(colorPicker.value));
  hexInput.addEventListener('change', () => {
    let hex = hexInput.value.trim();
    if (hex && hex[0] !== '#') hex = '#' + hex;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      setColor(hex);
    } else {
      hexInput.value = currentColor.toUpperCase();
    }
  });

  // Undo / Clear / Mirror
  document.getElementById('undoBtn').addEventListener('click', undoCanvas);
  document.getElementById('clearBtn').addEventListener('click', clearCanvas);
  document.getElementById('mirrorBtn').addEventListener('click', toggleMirror);

  // Canvas toolbar
  document.getElementById('zoomInBtn').addEventListener('click', zoomIn);
  document.getElementById('zoomOutBtn').addEventListener('click', zoomOut);
  document.getElementById('saveToLibraryBtn').addEventListener('click', () => saveToLibrary());
  document.getElementById('exportSvgBtn').addEventListener('click', exportSVG);
  document.getElementById('resetBtn').addEventListener('click', confirmClear);

  // Import SVG into the Heritage Library
  document.getElementById('importSvgBtn').addEventListener('click', () => {
    document.getElementById('importSvgInput').click();
  });
  document.getElementById('importSvgInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // reset so importing the same file again still fires 'change'
    if (file) importSvgFile(file);
  });

  // G-code panel
  document.getElementById('copyGcodeBtn').addEventListener('click', copyGCode);
  document.getElementById('downloadGcodeBtn').addEventListener('click', downloadGCode);
  document.getElementById('generateGcodeBtn').addEventListener('click', generateGCode);

  // Send to robot
  document.getElementById('sendBtn').addEventListener('click', sendToRobot);
  document.getElementById('serialConnectBtn').addEventListener('click', connectSerial);
  document.getElementById('modeUsbBtn').addEventListener('click', () => setSendMode('usb'));
  document.getElementById('modeWifiBtn').addEventListener('click', () => setSendMode('wifi'));

  // Modal
  document.getElementById('modalCancelBtn').addEventListener('click', closeModal);

  // AI drawer
  document.getElementById('aiToggleBtn').addEventListener('click', toggleAiDrawer);
  document.getElementById('aiDrawerClose').addEventListener('click', toggleAiDrawer);
  document.getElementById('tabFunfact').addEventListener('click', () => switchAiTab('funfact'));
  document.getElementById('tabChat').addEventListener('click', () => switchAiTab('chat'));
  document.querySelectorAll('.ai-lang-btn[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => setAiLanguage(btn.dataset.lang));
  });
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

  // Fill is a single click, not a drag — handle and bail out before the
  // isDrawing/currentStroke drag machinery below engages.
  if (currentTool === 'fill') {
    saveHistory(); // pre-fill state, mirrors the drag tools' start-of-stroke saveHistory()
    vectorStrokes.push({ tool:'fill', color:currentColor, points:[{x,y}] });
    floodFillCtx(ctx, x, y, currentColor);
    if (symmetryMode) {
      const mx = canvas.width - x;
      vectorStrokes.push({ tool:'fill', color:currentColor, points:[{x:mx, y}] });
      floodFillCtx(ctx, mx, y, currentColor);
    }
    saveHistory(); // post-fill state
    document.getElementById('canvasHint').style.opacity = '0';
    document.getElementById('canvasInfo').textContent = `500 × 500 px · Draw mode · ${vectorStrokes.length} stroke(s)`;
    return;
  }

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
    if (stroke.tool === 'fill') {
      if (stroke.points && stroke.points[0]) {
        floodFillCtx(c, stroke.points[0].x * scale, stroke.points[0].y * scale, stroke.color);
      }
      return;
    }
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
//  BUCKET FILL — pixel-level scanline flood fill, recorded as a
//  {tool:'fill', color, points:[{x,y}]} entry in vectorStrokes so
//  drawStrokesOnCtx() replays it (in order, alongside pen/line/eraser
//  strokes) on every redraw — undo, thumbnails, and library reloads
//  all go through drawStrokesOnCtx, so the fill has to be replayable
//  from the seed point rather than a one-off pixel edit.
// ============================================================
let _colorProbeCtx = null;
function colorToRgba(colorStr) {
  if (!_colorProbeCtx) {
    const t = document.createElement('canvas');
    t.width = t.height = 1;
    _colorProbeCtx = t.getContext('2d');
  }
  _colorProbeCtx.clearRect(0, 0, 1, 1);
  _colorProbeCtx.fillStyle = colorStr;
  _colorProbeCtx.fillRect(0, 0, 1, 1);
  return _colorProbeCtx.getImageData(0, 0, 1, 1).data;
}

function floodFillCtx(c, seedX, seedY, fillColorStr) {
  const w = c.canvas.width, h = c.canvas.height;
  seedX = Math.round(seedX);
  seedY = Math.round(seedY);
  if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h) return;

  const imgData = c.getImageData(0, 0, w, h);
  const data = imgData.data;
  const idx = (x, y) => (y * w + x) * 4;

  const seedI  = idx(seedX, seedY);
  const target = [data[seedI], data[seedI+1], data[seedI+2], data[seedI+3]];
  const fill   = colorToRgba(fillColorStr);

  // Tolerance absorbs the anti-aliased edge pixels around strokes so the
  // fill doesn't stop one pixel short of (or leak past) a boundary.
  const TOLERANCE = 40;
  const matches = (i) =>
    Math.abs(data[i]   - target[0]) <= TOLERANCE &&
    Math.abs(data[i+1] - target[1]) <= TOLERANCE &&
    Math.abs(data[i+2] - target[2]) <= TOLERANCE &&
    Math.abs(data[i+3] - target[3]) <= TOLERANCE;

  if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) {
    return; // already exactly this color — nothing to do
  }

  const setColor = (i) => {
    data[i] = fill[0]; data[i+1] = fill[1]; data[i+2] = fill[2]; data[i+3] = fill[3];
  };

  // Scanline flood fill: fill whole horizontal spans at once and only
  // queue one seed per contiguous span above/below, instead of pushing
  // every individual pixel — much faster than a naive 4-way stack fill.
  const stack = [[seedX, seedY]];
  while (stack.length) {
    const [sx, sy] = stack.pop();
    if (!matches(idx(sx, sy))) continue;

    let xl = sx;
    while (xl > 0 && matches(idx(xl - 1, sy))) xl--;
    let xr = sx;
    while (xr < w - 1 && matches(idx(xr + 1, sy))) xr++;

    let spanAbove = false, spanBelow = false;
    for (let xi = xl; xi <= xr; xi++) {
      setColor(idx(xi, sy));

      if (sy > 0) {
        const above = matches(idx(xi, sy - 1));
        if (above && !spanAbove) { stack.push([xi, sy - 1]); spanAbove = true; }
        else if (!above) spanAbove = false;
      }
      if (sy < h - 1) {
        const below = matches(idx(xi, sy + 1));
        if (below && !spanBelow) { stack.push([xi, sy + 1]); spanBelow = true; }
        else if (!below) spanBelow = false;
      }
    }
  }

  c.putImageData(imgData, 0, 0);
}

// ============================================================
//  TOOLS
// ============================================================
function setTool(t) {
  currentTool = t;
  ['Pen','Line','Eraser','Fill'].forEach(id => {
    document.getElementById('tool'+id).classList.remove('active');
  });
  document.getElementById('tool' + t.charAt(0).toUpperCase() + t.slice(1)).classList.add('active');
  canvas.style.cursor = t === 'eraser' ? 'cell' : t === 'fill' ? 'pointer' : 'crosshair';
}

function setColor(c, el) {
  currentColor = c;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  if (el) el.classList.add('active');
  const colorPicker = document.getElementById('colorPicker');
  const hexInput = document.getElementById('hexInput');
  if (colorPicker) colorPicker.value = c;
  if (hexInput) hexInput.value = c.toUpperCase();
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

  // HeriTech work area, mm. Kept deliberately small (no limit switches, no
  // real homing) so hand-centering error still can't reach the brackets:
  // 100x100mm is only ±50mm from the centered origin, well inside the Y
  // rail's ~100mm-each-way travel even if the pen isn't parked dead center.
  // Once you're confident in your manual centering, raise this gradually
  // and test a few empty-corner runs before trusting a full drawing.
  const fabricW = 100, fabricH = 100;
  const scaleX  = fabricW / canvas.width;
  const scaleY  = fabricH / canvas.height;
  // Origin (X0 Y0) is the BOTTOM-LEFT corner of the paper — park the pen
  // there before sending, and G28 will latch that spot as (0,0). Every
  // coordinate below comes out >= 0 (X grows right, Y grows up off that
  // corner), so the carriage only ever travels *away* from home, never
  // back past it into the bracket.
  //
  // Canvas Y grows downward (0 = top), so it's flipped here to match "up
  // off the bottom-left corner" = increasing G-code Y.

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
    const sy = (fabricH - pts[0].y * scaleY).toFixed(2);
    lines.push(`G0 X${sx} Y${sy}`);
    lines.push(`M3 S255    ; lower chalk`);

    // Draw through points (downsample pen strokes to reduce file size)
    const step = stroke.tool === 'pen' ? Math.max(1, Math.floor(pts.length/60)) : 1;
    for (let j = step; j < pts.length; j += step) {
      const gx = (pts[j].x * scaleX).toFixed(2);
      const gy = (fabricH - pts[j].y * scaleY).toFixed(2);
      lines.push(`G1 X${gx} Y${gy}`);
    }
    // Ensure last point
    const ex = (pts[pts.length-1].x * scaleX).toFixed(2);
    const ey = (fabricH - pts[pts.length-1].y * scaleY).toFixed(2);
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
    <span class="gcode-line-comment">; 3. Send to Arduino (USB) or ESP32 (Wi-Fi)</span>`;
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
//  SEND TO ROBOT
//  Two transports:
//   - USB: Web Serial straight to an Arduino running Gcode-streamer.ino
//     (line-by-line, wait for "ok" before sending the next line — same
//     handshake Grbl uses, so this also works with a real Grbl board).
//   - Wi-Fi: WebSocket to an ESP32 running a Grbl websocket bridge.
// ============================================================
let sendMode = 'usb'; // 'usb' | 'wifi'

function setSendMode(mode) {
  sendMode = mode;
  document.getElementById('modeUsbBtn').classList.toggle('active', mode === 'usb');
  document.getElementById('modeWifiBtn').classList.toggle('active', mode === 'wifi');
  document.getElementById('wifiRow').style.display = mode === 'wifi' ? 'flex' : 'none';
  document.getElementById('serialConnectBtn').style.display = mode === 'usb' ? 'block' : 'none';
  document.getElementById('sendBtn').textContent = mode === 'usb' ? '▶ Send to Arduino' : '▶ Send to HeriTech Robot';
}

// --- USB (Web Serial) ---
let serialPort         = null;
let serialWriter        = null;
let serialLineWaiters   = [];  // resolvers waiting on the next line from the board
let serialLineBuffer    = '';

async function connectSerial() {
  if (!('serial' in navigator)) {
    showToast('Web Serial not supported — use Chrome or Edge');
    document.getElementById('sendStatus').textContent = "⚠ This browser can't talk to USB devices. Use Chrome or Edge on desktop.";
    return;
  }

  const btn = document.getElementById('serialConnectBtn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    serialPort = port;
    serialWriter = serialPort.writable.getWriter();
    startSerialReadLoop();
    btn.textContent = '✓ Arduino Connected';
    document.getElementById('sendStatus').textContent = 'Arduino connected — generate G-code and send.';
    showToast('Arduino connected ✓');
  } catch (err) {
    serialPort = null;
    serialWriter = null;
    btn.textContent = '🔌 Connect Arduino';
    document.getElementById('sendStatus').textContent = describeSerialError(err);
    showToast('Could not open that port');
  } finally {
    btn.disabled = false;
  }
}

function describeSerialError(err) {
  const msg = (err && err.message) || String(err);
  if (/failed to open serial port/i.test(msg)) {
    return '⚠ Port is busy — close the Arduino IDE Serial Monitor (or any other app/tab using this port), then try again.';
  }
  return '⚠ ' + msg;
}

// Best-effort: release the port on reload/close so it isn't left locked for the next attempt.
window.addEventListener('beforeunload', () => {
  if (serialPort) serialPort.close().catch(() => {});
});

async function startSerialReadLoop() {
  const decoder = new TextDecoderStream();
  const closed = serialPort.readable.pipeTo(decoder.writable);
  const reader = decoder.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      serialLineBuffer += value;
      let idx;
      while ((idx = serialLineBuffer.indexOf('\n')) >= 0) {
        const line = serialLineBuffer.slice(0, idx).trim();
        serialLineBuffer = serialLineBuffer.slice(idx + 1);
        if (line && serialLineWaiters.length) serialLineWaiters.shift()(line);
      }
    }
  } catch (err) {
    console.error('Serial read loop ended:', err);
  } finally {
    reader.releaseLock();
    closed.catch(() => {});
    serialPort = null;
    serialWriter = null;
    document.getElementById('serialConnectBtn').textContent = '🔌 Connect Arduino';
  }
}

function waitForSerialLine(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const onLine = (line) => { clearTimeout(timer); resolve(line); };
    const timer = setTimeout(() => {
      const idx = serialLineWaiters.indexOf(onLine);
      if (idx >= 0) serialLineWaiters.splice(idx, 1);
      reject(new Error('Arduino did not respond in time'));
    }, timeoutMs);
    serialLineWaiters.push(onLine);
  });
}

async function sendToArduinoUSB() {
  const btn = document.getElementById('sendBtn');
  if (!serialPort || !serialWriter) {
    showToast('Connect your Arduino first');
    document.getElementById('sendStatus').textContent = 'Click "Connect Arduino" first, then send.';
    return;
  }

  const gcodeLines = gcodeContent.split('\n').filter(l => l.trim() && !l.startsWith(';'));
  btn.disabled = true;
  btn.textContent = 'Sending…';
  setStep(4);

  try {
    for (let i = 0; i < gcodeLines.length; i++) {
      await serialWriter.write(new TextEncoder().encode(gcodeLines[i] + '\n'));
      document.getElementById('sendStatus').textContent = `Sending line ${i + 1}/${gcodeLines.length}…`;
      await waitForSerialLine(); // wait for "ok" before the next line, matches Gcode-streamer.ino's handshake
    }
    document.getElementById('sendStatus').textContent = `✓ All ${gcodeLines.length} lines sent successfully`;
    btn.textContent = '✓ Sent';
    showToast('G-code sent to Arduino! ✓');
  } catch (err) {
    document.getElementById('sendStatus').textContent = '⚠ ' + err.message;
    btn.textContent = '▶ Send to Arduino';
    showToast('Send failed — check the USB connection');
  } finally {
    btn.disabled = false;
  }
}

// --- Wi-Fi (WebSocket to ESP32 Grbl) ---
async function sendToRobotWifi() {
  const ip = document.getElementById('espIpInput').value.trim();
  if (!ip) { showToast('Enter ESP32 IP address'); return; }

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

async function sendToRobot() {
  if (!gcodeReady) { showToast('Generate G-code first'); return; }
  if (sendMode === 'usb') await sendToArduinoUSB();
  else await sendToRobotWifi();
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

function backendUrl(path) {
  return isLocalDev()
    ? `http://localhost:3000${path}`
    : `https://heritech.onrender.com${path}`;
}

async function callAI(systemPrompt, messages) {
  const response = await fetch(backendUrl('/api/chat'), {
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
//
//  Voice is rendered server-side via OpenAI's gpt-4o-mini-tts
//  (see /api/tts in server.js) rather than the browser's built-in
//  speechSynthesis, which sounds noticeably more human and handles
//  pronunciation of Orang Ulu / beadwork terms far more reliably.
// ============================================================
let isSpeaking = false;
let currentAudio = null;
let ttsAbortController = null;
let ttsRequestId = 0;

function ttsSupported() {
  return typeof Audio !== 'undefined';
}

async function speakText(text, lang = aiLanguage) {
  if (!text || !ttsSupported()) return;
  stopSpeaking(); // interrupt whatever is currently playing or loading

  const requestId = ++ttsRequestId;
  ttsAbortController = new AbortController();

  try {
    const response = await fetch(backendUrl('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang }),
      signal: ttsAbortController.signal
    });

    if (requestId !== ttsRequestId) return; // superseded by a newer speakText() call

    if (!response.ok) {
      let msg = `Voice server error (${response.status})`;
      try {
        const err = await response.json();
        if (err.error) msg = err.error;
      } catch {}
      throw new Error(msg);
    }

    const blob = await response.blob();
    if (requestId !== ttsRequestId) return; // superseded while the audio was downloading

    const audio = new Audio(URL.createObjectURL(blob));
    currentAudio = audio;

    audio.onplay  = () => { isSpeaking = true;  updateTtsButtons(); };
    audio.onended = () => { isSpeaking = false; updateTtsButtons(); URL.revokeObjectURL(audio.src); };
    audio.onerror = () => {
      isSpeaking = false;
      updateTtsButtons();
      setVoiceStatus('Voice readout failed to play.');
    };

    await audio.play();
  } catch (error) {
    if (error.name === 'AbortError') return; // expected — superseded by a newer speakText() call
    console.error('[tts] error:', error);
    isSpeaking = false;
    updateTtsButtons();
    setVoiceStatus('Voice readout failed: ' + error.message);
  }
}

function stopSpeaking() {
  if (ttsAbortController) {
    ttsAbortController.abort();
    ttsAbortController = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  isSpeaking = false;
  updateTtsButtons();
}

// Keeps every Replay/Stop button — in chat bubbles AND the Fun Fact
// card — in sync with playback state, since only one currentAudio
// plays at a time regardless of which button triggered it.
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
    console.log('[voice] getUserMedia succeeded — permission granted');
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch (error) {
    console.log('[voice] getUserMedia failed —', error.name, error.message);
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
  console.log('[voice] mic button clicked');

  if (!speechRecognition) {
    console.log('[voice] no speechRecognition instance — falling back to text input');
    fallbackVoiceInput();
    return;
  }

  if (isListening) {
    console.log('[voice] already listening — stopping');
    speechRecognition.stop();
    return;
  }

  lastVoiceTranscript = '';
  document.getElementById('chatInput').value = '';

  console.log('[voice] requesting microphone permission...');
  const granted = await ensureMicrophoneAccess();
  console.log('[voice] microphone permission granted:', granted);
  if (!granted) {
    fallbackVoiceInput();
    return;
  }

  try {
    setVoiceStatus('Listening... speak now.');
    console.log('[voice] starting speechRecognition.start()');
    speechRecognition.start();

    // Watchdog: a working SpeechRecognition engine always fires onstart
    // (or onerror) within a moment of start(). If neither has fired
    // after 3s, the API exists but isn't actually backed by a working
    // speech service in this runtime (common in embedded webviews /
    // in-editor previews) — start() silently no-ops instead of throwing.
    window.setTimeout(() => {
      if (!isListening) {
        console.warn('[voice] WATCHDOG: 3s after start() with no onstart/onerror/onend event. ' +
          'SpeechRecognition exists but never actually activated the microphone. ' +
          'This is NOT a code bug in the click handler — the recognizer itself is silent. ' +
          'Common cause: viewing this page inside an embedded preview/webview (e.g. a VS Code ' +
          'preview panel) instead of a real Chrome/Edge browser tab, where the Web Speech API ' +
          'has no working speech-recognition backend. Try opening the page in a standalone ' +
          'Chrome or Edge window instead.');
        setVoiceStatus('No response from the speech engine. Try opening this page in a real Chrome/Edge browser tab instead of an embedded preview.');
      }
    }, 3000);
  } catch (err) {
    console.log('[voice] speechRecognition.start() threw:', err);
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
    console.log('[voice] setupVoiceControls: unsupported browser or insecure context — ' +
      'SpeechRecognitionCtor: ' + !!SpeechRecognitionCtor + ', isSecureContext: ' + window.isSecureContext);
    voiceBtn.addEventListener('click', fallbackVoiceInput);
    fallbackVoiceInput();
    return;
  }

  console.log('[voice] setupVoiceControls: SpeechRecognition supported, wiring up handlers');
  speechRecognition = new SpeechRecognitionCtor();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-US';

  speechRecognition.onstart = () => {
    console.log('[voice] onstart — mic is now capturing audio');
    isListening = true;
    voiceBtn.classList.add('listening');
    voiceBtn.title = 'Listening...';
    stopBtn.disabled = false;
    setVoiceStatus('Listening... speak now.');
  };

  speechRecognition.onaudiostart = () => {
    console.log('[voice] onaudiostart — audio capture confirmed by the browser');
  };

  speechRecognition.onspeechstart = () => {
    console.log('[voice] onspeechstart — speech detected in the audio stream');
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

    console.log('[voice] onresult — interim:', JSON.stringify(interim), 'final:', JSON.stringify(finalText));

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
    console.log('[voice] onerror —', event.error);
    isListening = false;
    voiceBtn.classList.remove('listening');
    stopBtn.disabled = true;
    const errorMessage = event.error === 'not-allowed'
      ? 'Please allow microphone access for this site.'
      : `Voice error: ${event.error}`;
    setVoiceStatus(errorMessage);
  };

  speechRecognition.onend = () => {
    console.log('[voice] onend — recognition session ended. lastVoiceTranscript:', JSON.stringify(lastVoiceTranscript));
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

// Applies to both the Fun Fact and Chat tabs — 'en' or 'ms' (Bahasa
// Malaysia). Drives both the system prompt language (see
// languageInstruction()) and the TTS accent/voice instructions
// (see speakText() and /api/tts in server.js).
let aiLanguage = 'en';

function setAiLanguage(lang) {
  aiLanguage = lang;
  document.querySelectorAll('.ai-lang-btn[data-lang]').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
}

function languageInstruction() {
  return aiLanguage === 'ms'
    ? 'Respond entirely in natural, conversational Bahasa Malaysia (Malay), as spoken in Sarawak/Malaysia — not English. '
    : '';
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
      'Keep each fact to 2–3 sentences. Be specific and vivid. ' + languageInstruction() + avoid,
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

  card.appendChild(buildTtsControls(text, aiLanguage, body));
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
    div.appendChild(buildTtsControls(text, aiLanguage, body));
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// Translates `text` into 'en' or 'ms' via the lightweight /api/translate
// endpoint (kept separate from /api/chat so switching a message's
// language doesn't re-run the whole cultural-guide persona/prompt).
async function translateText(text, targetLang) {
  const response = await fetch(backendUrl('/api/translate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target: targetLang })
  });

  if (!response.ok) {
    let msg = `Translate error (${response.status})`;
    try {
      const err = await response.json();
      if (err.error) msg = err.error;
    } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  return data.text || text;
}

// Builds Replay/Stop + a per-message EN/BM switch wired to speak/show
// `text`. Shared by chat bubbles (appendChatMsg) and the Fun Fact card
// (loadFunFact). `lang` is the language `text` is already written in.
//
// When `textEl` is given, the EN/BM buttons let a single message be
// switched to the other language on the spot: the text is translated
// via /api/translate (cached per-message so flipping back and forth
// doesn't re-translate), textEl's content is swapped, and the result
// is spoken immediately — no page refresh or new AI reply needed.
function buildTtsControls(text, lang = aiLanguage, textEl = null) {
  const controls = document.createElement('div');
  controls.className = 'tts-controls';

  const cache = { [lang]: text };
  let currentLang = lang;

  const replayBtn = document.createElement('button');
  replayBtn.className = 'tts-btn tts-replay';
  replayBtn.textContent = '🔊 Replay';
  replayBtn.disabled = !ttsSupported();
  replayBtn.addEventListener('click', () => speakText(cache[currentLang], currentLang));

  const stopBtn = document.createElement('button');
  stopBtn.className = 'tts-btn tts-stop';
  stopBtn.textContent = '⏹ Stop';
  stopBtn.disabled = !isSpeaking;
  stopBtn.addEventListener('click', stopSpeaking);

  controls.appendChild(replayBtn);
  controls.appendChild(stopBtn);

  if (textEl) {
    let enBtn, bmBtn;

    const selectLang = async (code) => {
      if (code === currentLang) { speakText(cache[currentLang], currentLang); return; }

      if (!cache[code]) {
        enBtn.disabled = true;
        bmBtn.disabled = true;
        try {
          cache[code] = await translateText(cache[currentLang], code);
        } catch (e) {
          setVoiceStatus('Translation failed: ' + e.message);
          enBtn.disabled = false;
          bmBtn.disabled = false;
          return;
        }
        enBtn.disabled = false;
        bmBtn.disabled = false;
      }

      currentLang = code;
      textEl.textContent = cache[code];
      enBtn.classList.toggle('active', code === 'en');
      bmBtn.classList.toggle('active', code === 'ms');
      speakText(cache[code], code);
    };

    enBtn = document.createElement('button');
    enBtn.className = 'tts-btn tts-lang-btn' + (currentLang === 'en' ? ' active' : '');
    enBtn.textContent = 'EN';
    enBtn.title = 'Show and hear this message in English';
    enBtn.addEventListener('click', () => selectLang('en'));

    bmBtn = document.createElement('button');
    bmBtn.className = 'tts-btn tts-lang-btn' + (currentLang === 'ms' ? ' active' : '');
    bmBtn.textContent = 'BM';
    bmBtn.title = 'Show and hear this message in Bahasa Malaysia';
    bmBtn.addEventListener('click', () => selectLang('ms'));

    const langSwitch = document.createElement('div');
    langSwitch.className = 'tts-lang-switch';
    langSwitch.appendChild(enBtn);
    langSwitch.appendChild(bmBtn);
    controls.appendChild(langSwitch);
  }

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
      'If asked about non-Orang Ulu topics, gently redirect to cultural or heritage topics. ' +
      languageInstruction(),
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

/* ============================================================
   CULTURAL MOTIF TOOLTIPS
   Drives the five header motif icons: shows a shared tooltip
   card on hover or keyboard focus. Vanilla JS, no dependencies.
   ============================================================ */
const MOTIF_INFO = {
  aso: {
    name: 'Aso',
    native: 'Dog / Dragon Motif',
    groups: ['Kenyah', 'Kayan'],
    desc: "The Aso is one of the best-known figures in Kenyah and Kayan carving and beadwork — a mythical dog-dragon whose curling, interlocking form once marked the belongings of noble households. Carved onto longhouse posts and painted onto shields, it stood guard against unseen harm, and today it's still drawn as a mark of protection and courage."
  },
  paku: {
    name: 'Paku',
    native: 'Fern Frond Motif',
    groups: ['Kenyah', 'Kayan', 'Kelabit', 'Penan'],
    desc: "Named for the young fiddlehead fern that uncurls across the rainforest floor, Paku is one of the most widespread Orang Ulu motifs — simple enough for a first-time beader, versatile enough to fill any border. Its endless curling line stands for new growth and the forest's quiet persistence."
  },
  hornbill: {
    name: 'Burung Enggang',
    native: 'Hornbill Motif',
    groups: ['Kenyah', 'Kayan'],
    desc: "The hornbill is one of the most revered birds across Borneo's interior — seen as a messenger between the living and the ancestors, and once a mark of a great warrior's standing. Its casque and wings are rendered here in the angular, geometric style typical of beadwork rather than as a literal illustration."
  },
  mata: {
    name: 'Mata',
    native: 'Eye / Diamond Motif',
    groups: ['Kenyah', 'Kayan', 'Kelabit'],
    desc: "Mata means \"eye\" — a diamond-within-a-diamond that turns up in beadwork, tattoos, and basket weaving alike. It's worn and woven as a watchful symbol, believed to turn away misfortune while sharpening the wearer's own awareness."
  },
  ukir: {
    name: 'Ukir',
    native: 'Spiral Carving Motif',
    groups: ['Kayan', 'Kenyah'],
    desc: "Ukir refers broadly to the carved and beaded spiral work found throughout Orang Ulu material culture. These interlocking curves have no clear start or end — which is exactly the point. They're read as a line of ancestry and continuity, running from one generation into the next."
  }
};

(function setupMotifTooltips() {
  const tooltip = document.getElementById('motifTooltip');
  const icons = document.querySelectorAll('.motif-icon-btn');
  if (!tooltip || !icons.length) return;

  function renderTooltip(key) {
    const info = MOTIF_INFO[key];
    if (!info) return;
    tooltip.innerHTML =
      '<div class="motif-tooltip-name">' + info.name + '</div>' +
      '<div class="motif-tooltip-native">' + info.native + '</div>' +
      '<div class="motif-tooltip-desc">' + info.desc + '</div>' +
      '<div class="motif-tooltip-groups">' +
        info.groups.map(function (g) { return '<span>' + g + '</span>'; }).join('') +
      '</div>';
  }

  function positionTooltip(btn) {
    const r = btn.getBoundingClientRect();
    const tw = tooltip.offsetWidth || 260;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - tw - 10));
    tooltip.style.left = left + 'px';
    tooltip.style.top = (r.bottom + 8) + 'px';
  }

  function showTooltip(btn) {
    renderTooltip(btn.dataset.motif);
    tooltip.classList.add('show');
    positionTooltip(btn);
  }

  function hideTooltip() {
    tooltip.classList.remove('show');
  }

  icons.forEach(function (btn) {
    btn.addEventListener('mouseenter', function () { showTooltip(btn); });
    btn.addEventListener('mouseleave', hideTooltip);
    btn.addEventListener('focus', function () { showTooltip(btn); });
    btn.addEventListener('blur', hideTooltip);
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideTooltip(); btn.blur(); }
    });
  });

  window.addEventListener('scroll', hideTooltip, true);
  window.addEventListener('resize', hideTooltip);
})();