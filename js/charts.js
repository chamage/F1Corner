// =============================================
// PITCORNER — Lightweight Canvas Charts
// No dependencies — pure canvas rendering
// =============================================

/**
 * Draw a multi-line chart (lap times, etc.)
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{label, data: number[], color}>} datasets
 * @param {Object} options
 */
export function drawLineChart(canvas, datasets, options = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  const {
    padTop = 20,
    padRight = 20,
    padBottom = 40,
    padLeft = 60,
    yLabel = '',
    xLabel = '',
    invertY = false,
    gridLines = true,
    showDots = false,
    lineWidth = 1.5,
    yMin: forceYMin,
    yMax: forceYMax,
  } = options;

  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;

  // Find data bounds
  let allVals = datasets.flatMap(d => d.data.filter(v => v != null && !isNaN(v)));
  if (!allVals.length) {
    ctx.fillStyle = '#5a5a72';
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data available', W / 2, H / 2);
    return;
  }

  let yMin = forceYMin ?? Math.min(...allVals);
  let yMax = forceYMax ?? Math.max(...allVals);
  const yPad = (yMax - yMin) * 0.08 || 1;
  yMin -= yPad;
  yMax += yPad;

  const maxLen = Math.max(...datasets.map(d => d.data.length));

  function xPos(i) { return padLeft + (i / (maxLen - 1 || 1)) * plotW; }
  function yPos(v) {
    const ratio = (v - yMin) / (yMax - yMin);
    return invertY
      ? padTop + ratio * plotH
      : padTop + (1 - ratio) * plotH;
  }

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Grid
  if (gridLines) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const gridCount = 5;
    for (let i = 0; i <= gridCount; i++) {
      const y = padTop + (plotH / gridCount) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      // Y labels
      const val = invertY
        ? yMin + ((yMax - yMin) / gridCount) * i
        : yMax - ((yMax - yMin) / gridCount) * i;
      ctx.fillStyle = '#5a5a72';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(val.toFixed(1), padLeft - 8, y + 3);
    }
  }

  // X axis labels
  if (maxLen > 1) {
    ctx.fillStyle = '#5a5a72';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(maxLen / 10));
    for (let i = 0; i < maxLen; i += step) {
      ctx.fillText(i + 1, xPos(i), H - padBottom + 20);
    }
    if (xLabel) {
      ctx.fillText(xLabel, padLeft + plotW / 2, H - 5);
    }
  }

  // Draw lines
  for (const ds of datasets) {
    ctx.strokeStyle = ds.color || '#e10600';
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = ds.alpha || 0.85;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < ds.data.length; i++) {
      const v = ds.data[i];
      if (v == null || isNaN(v)) { started = false; continue; }
      const x = xPos(i);
      const y = yPos(v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (showDots) {
      for (let i = 0; i < ds.data.length; i++) {
        const v = ds.data[i];
        if (v == null || isNaN(v)) continue;
        ctx.beginPath();
        ctx.arc(xPos(i), yPos(v), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = ds.color || '#e10600';
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * Draw position chart (P1 at top) — inverted Y axis
 */
export function drawPositionChart(canvas, datasets, options = {}) {
  drawLineChart(canvas, datasets, {
    ...options,
    invertY: true,
    yMin: 0.5,
    yMax: Math.max(20, ...(datasets.flatMap(d => d.data.filter(v => v != null)))) + 0.5,
    lineWidth: 2,
  });
}

/**
 * Draw a horizontal bar chart
 */
export function drawBarChart(canvas, data, options = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  const { padLeft = 60, padRight = 20, padTop = 10, padBottom = 10, barHeight = 24, gap = 6 } = options;

  const maxVal = Math.max(...data.map(d => d.value), 1);

  data.forEach((item, i) => {
    const y = padTop + i * (barHeight + gap);
    const barW = ((item.value / maxVal) * (W - padLeft - padRight));

    // Label
    ctx.fillStyle = '#9898ad';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(item.label, padLeft - 8, y + barHeight / 2 + 4);

    // Bar
    ctx.fillStyle = item.color || '#e10600';
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.roundRect(padLeft, y, Math.max(barW, 2), barHeight, 4);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Value
    ctx.fillStyle = '#f0f0f5';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(item.value, padLeft + barW + 8, y + barHeight / 2 + 4);
  });
}

/**
 * Draw a tiny sparkline
 */
export function drawSparkline(canvas, data, color = '#e10600', filled = false) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  const vals = data.filter(v => v != null && !isNaN(v));
  if (vals.length < 2) return;

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;

  const pad = filled ? 8 : 2;
  const points = [];

  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v == null || isNaN(v)) continue;
    const x = pad + (i / (data.length - 1)) * (W - pad * 2);
    const y = pad + (1 - (v - min) / range) * (H - pad * 2);
    points.push({ x, y });
  }

  if (points.length < 2) return;

  // Filled area
  if (filled) {
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, color + '40');
    gradient.addColorStop(1, color + '05');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(points[0].x, H - pad);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[points.length - 1].x, H - pad);
    ctx.closePath();
    ctx.fill();
  }

  // Line
  ctx.strokeStyle = color;
  ctx.lineWidth = filled ? 2.5 : 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    if (i === 0) ctx.moveTo(points[i].x, points[i].y);
    else ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();

  // Dots on each data point (filled mode)
  if (filled) {
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'var(--bg-secondary)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  } else {
    // Just a dot on last value
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}
