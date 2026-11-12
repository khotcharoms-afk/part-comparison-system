import { useRef, useState, useEffect, useId } from "react";

/**
 * Shared calculations (also used from PartPage.jsx when saving to Firestore).
 */

// Averages up to N (x,y) measurement points, ignoring incomplete/invalid rows.
export function computeAveragePoint(points) {
  const valid = points
    .map(p => ({ x: parseFloat(p.x), y: parseFloat(p.y) }))
    .filter(p => !isNaN(p.x) && !isNaN(p.y));
  if (valid.length === 0) return { avgX: null, avgY: null, count: 0, valid: [] };
  const avgX = valid.reduce((s, p) => s + p.x, 0) / valid.length;
  const avgY = valid.reduce((s, p) => s + p.y, 0) / valid.length;
  return { avgX, avgY, count: valid.length, valid };
}

// Kept for the Firestore record PartPage.jsx saves alongside each inspection — the chart
// itself no longer uses angle for its visual (see below), since it read confusingly:
// a point's angle depends on both X and Y together, so "more negative Y" didn't always
// mean "lower on the chart", which was surprising. The chart now plots raw Gain Y instead.
export function computeAngleInfo(standardX, standardY, measuredX, measuredY) {
  const sx = parseFloat(standardX), sy = parseFloat(standardY);
  const mx = parseFloat(measuredX), my = parseFloat(measuredY);

  const hasStandard = !isNaN(sx) && !isNaN(sy) && (sx !== 0 || sy !== 0);
  const hasMeasured = !isNaN(mx) && !isNaN(my) && (mx !== 0 || my !== 0);

  const angleStandard = hasStandard ? Math.atan2(sy, sx) * (180 / Math.PI) : null;
  const angleMeasured = hasMeasured ? Math.atan2(my, mx) * (180 / Math.PI) : null;

  let angleDiff = null, angleDiffPercent = null;
  if (angleStandard !== null && angleMeasured !== null) {
    let d = angleMeasured - angleStandard;
    d = ((d + 180) % 360 + 360) % 360 - 180;
    angleDiff = d;
    angleDiffPercent = (Math.abs(d) / 180) * 100;
  }

  return { angleStandard, angleMeasured, angleDiff, angleDiffPercent };
}

// "Nice" round tick values (…, 0.9, 1.0, 1.1, … or 0, 2, 4, …) inside [min, max]
function niceTicks(min, max, count = 6) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    ticks.push(+v.toFixed(10));
  }
  return { ticks, step };
}
function fmtTick(v, step) {
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(Math.min(dec, 3));
}

// Builds a smooth SVG path ("d" attribute) through a series of points using
// monotone cubic (Fritsch–Carlson) interpolation, so the measured-value line
// curves gently between points instead of connecting them with sharp straight
// segments — WITHOUT overshooting past the data's local highs/lows.
//
// Note: a plain Catmull-Rom spline (an earlier approach here) computes each
// segment's curvature using the neighboring points on both sides, so even two
// points with the exact same value can get pulled into a visible bump/dip if
// the point just before or after them differs. Monotone interpolation avoids
// that: whenever consecutive points are equal (or the trend flattens), the
// tangents are forced to zero and that stretch renders as a true flat line.
function smoothPathFromPoints(pts) {
  const n = pts.length;
  if (n === 0 || n === 1) return "";
  if (n === 2) {
    return `M${pts[0].px},${pts[0].py} L${pts[1].px},${pts[1].py}`;
  }

  const xs = pts.map(p => p.px);
  const ys = pts.map(p => p.py);

  // secant slope of each segment between consecutive points
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    d.push(dx === 0 ? 0 : (ys[i + 1] - ys[i]) / dx);
  }

  // initial tangent at each point (average of neighboring secants; zero at
  // any local flat/turning point so the curve doesn't overshoot through it)
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || (d[i - 1] > 0) !== (d[i] > 0)) {
      m[i] = 0;
    } else {
      m[i] = (d[i - 1] + d[i]) / 2;
    }
  }

  // Fritsch–Carlson step: clamp tangents so no segment can bulge past the
  // range of its two endpoints
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }

  let path = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    const cp1x = xs[i] + dx / 3;
    const cp1y = ys[i] + (m[i] * dx) / 3;
    const cp2x = xs[i + 1] - dx / 3;
    const cp2y = ys[i + 1] - (m[i + 1] * dx) / 3;
    path += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return path;
}

const ZOOM_MIN = 1, ZOOM_MAX = 20;

/**
 * Horizontal "run chart" — like a tire wear-profile readout:
 * X axis = point number (#1..#N, position measured around the wheel, in the
 * order each point was entered)
 * Y axis = the raw Gain Y value entered at that point
 * A flat slate reference line marks the standard's average Gain Y so every point's
 * deviation from spec is visible at a glance, with a thin amber line marking the
 * average of what was actually measured. Both reference values are shown as
 * badges above the chart (not drawn on the line itself), so they never collide
 * with a data point's label.
 */
// Monotone cubic (Fritsch–Carlson) interpolator: no overshoot between points.
function monotoneInterp(xs, ys) {
  const n = xs.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array(n);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], q = a * a + b * b;
    if (q > 9) { const t = 3 / Math.sqrt(q); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (x > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k], t = (x - xs[k]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k]
      + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
  };
}

/**
 * The standard profile as a function of position across the tread,
 * t = 0 (left edge, first point) … 1 (right edge, last point).
 * The standard and the inspection may use different numbers of points —
 * comparing by position makes them line up.
 */
export function makeStandardFn(standardPoints, standardY) {
  const M = (standardPoints || []).length;
  const pts = (standardPoints || [])
    .map((p, i) => ({ t: M > 1 ? i / (M - 1) : 0.5, y: parseFloat(p?.y) }))
    .filter(p => Number.isFinite(p.y));
  if (pts.length >= 2) {
    const f = monotoneInterp(pts.map(p => p.t), pts.map(p => p.y));
    return { curve: true, at: f };
  }
  const sy = parseFloat(standardY);
  if (Number.isFinite(sy)) return { curve: false, at: () => sy };
  return { curve: false, at: () => null };
}
export const positionOf = (i, n) => (n > 1 ? i / (n - 1) : 0.5); // i is 0-based

/**
 * Reads the measured profile against the standard and describes it in plain Thai:
 * where it's worn (left edge / centre / right edge), any bulges, left-vs-right
 * imbalance, overall wear, and a verdict. Points run left edge (#1) → right edge (#N).
 * Returns { level: "ok"|"warning"|"critical"|null, verdict, findings: [{tone, text}] }.
 */
export function diagnoseProfile({ points, standardPoints, standardY, thresholds }) {
  const warn = Number(thresholds?.warning) || 5;
  const crit = Number(thresholds?.critical) || 10;
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const n = (points || []).length;
  const stdFn = makeStandardFn(standardPoints, standardY);
  const stdAt = i => stdFn.at(positionOf(i, n));
  const rows = [];
  (points || []).forEach((p, i) => {
    const y = num(p?.y), ref = stdAt(i);
    if (y === null || ref === null || ref === 0) return;
    rows.push({ idx: i + 1, pct: ((y - ref) / Math.abs(ref)) * 100 });
  });
  if (rows.length === 0) return { level: null, verdict: "", findings: [], worn: [], bulge: [], wornRange: "", bulgeRange: "" };

  const zoneOf = idx => {
    const t = (idx - 0.5) / n;
    return t < 1 / 3 ? "left" : t > 2 / 3 ? "right" : "center";
  };
  const ZONE = { left: "ขอบซ้าย", center: "กลางหน้ายาง", right: "ขอบขวา" };
  const ranges = idxs => {
    const out = [];
    idxs.forEach(i => {
      const last = out[out.length - 1];
      if (last && i === last[1] + 1) last[1] = i; else out.push([i, i]);
    });
    return out.map(([a, b]) => (a === b ? `#${a}` : `#${a}–#${b}`)).join(", ");
  };
  const findings = [];
  const worn = rows.filter(r => r.pct < -warn);
  const bulge = rows.filter(r => r.pct > warn);
  const mean = rows.reduce((s, r) => s + r.pct, 0) / rows.length;
  const spread = Math.max(...rows.map(r => r.pct)) - Math.min(...rows.map(r => r.pct));

  // --- wear ---
  if (worn.length === 0) {
    findings.push({ tone: "ok", text: `ไม่พบจุดสึกเกินเกณฑ์ (ทุกจุดต่ำกว่ามาตรฐานไม่เกิน ${warn}%)` });
  } else if (worn.length === rows.length && spread < warn) {
    findings.push({ tone: "warn", text: `สึกเท่าๆ กันทั้งหน้ายาง ประมาณ ${Math.abs(mean).toFixed(1)}% — ลักษณะสึกตามอายุการใช้งาน` });
  } else {
    const zones = [...new Set(worn.map(r => zoneOf(r.idx)))];
    const has = z => zones.includes(z);
    let where;
    if (zones.length === 1) where = `สึกที่${ZONE[zones[0]]}`;
    else if (has("left") && has("right") && !has("center")) where = "สึกที่ขอบทั้งสองข้าง (กลางหน้ายางยังปกติ)";
    else if (zones.length === 3) where = "สึกหลายช่วงทั่วหน้ายาง";
    else if (has("left")) where = "สึกจากขอบซ้ายเข้ามาถึงกลางหน้ายาง";
    else where = "สึกจากกลางหน้ายางไปทางขอบขวา";
    const worst = worn.reduce((a, b) => (b.pct < a.pct ? b : a));
    findings.push({
      tone: worn.some(r => r.pct < -crit) ? "bad" : "warn",
      text: `${where} — จุด ${ranges(worn.map(r => r.idx))} · ลึกสุดที่ #${worst.idx} (${worst.pct.toFixed(1)}%)`,
    });
  }

  // --- bulge ---
  if (bulge.length === 0) {
    findings.push({ tone: "ok", text: "ไม่พบยางบวมหรือนูนเกินเกณฑ์" });
  } else {
    const zones = [...new Set(bulge.map(r => zoneOf(r.idx)))].map(z => ZONE[z]).join(" / ");
    const top = bulge.reduce((a, b) => (b.pct > a.pct ? b : a));
    findings.push({
      tone: bulge.some(r => r.pct > crit) ? "bad" : "warn",
      text: `พบยางนูน/บวมที่${zones} — จุด ${ranges(bulge.map(r => r.idx))} · มากสุดที่ #${top.idx} (+${top.pct.toFixed(1)}%) ควรตรวจด้วยตาว่ามีรอยบวมหรือผิวแยกชั้นหรือไม่`,
    });
  }

  // --- left vs right balance ---
  const side = z => rows.filter(r => zoneOf(r.idx) === z);
  const L = side("left"), Rr = side("right");
  if (L.length && Rr.length) {
    const avg = a => a.reduce((s, r) => s + r.pct, 0) / a.length;
    const d = avg(L) - avg(Rr);
    if (Math.abs(d) >= warn) {
      findings.push({
        tone: "warn",
        text: `สองฝั่งสึกไม่เท่ากัน — ฝั่ง${d < 0 ? "ซ้าย" : "ขวา"}ต่ำกว่าอีกฝั่งประมาณ ${Math.abs(d).toFixed(1)}% อาจเกิดจากล้อเอียงหรือรับน้ำหนักไม่เท่ากัน ควรตรวจการติดตั้งล้อ`,
      });
    }
  }

  // --- overall ---
  findings.push({
    tone: "info",
    text: `โดยรวมหน้ายาง${mean < 0 ? "ต่ำกว่า" : "สูงกว่า"}มาตรฐานเฉลี่ย ${Math.abs(mean).toFixed(1)}% (วัดได้ ${rows.length}/${n} จุด)`,
  });

  const anyCrit = rows.some(r => Math.abs(r.pct) > crit);
  const anyWarn = rows.some(r => Math.abs(r.pct) >= warn);
  const level = anyCrit ? "critical" : anyWarn ? "warning" : "ok";
  const verdict = level === "critical" ? "🔴 มีจุดเกินเกณฑ์วิกฤต — ควรเปลี่ยนล้อหรือตรวจสอบละเอียด"
    : level === "warning" ? "⚠️ เริ่มมีอาการ — ติดตามในรอบตรวจถัดไป"
    : "✅ หน้ายางอยู่ในเกณฑ์ — ใช้งานต่อได้";
  return {
    level, verdict, findings, worn, bulge,
    wornRange: ranges(worn.map(r => r.idx)), bulgeRange: ranges(bulge.map(r => r.idx)),
  };
}

const POINT_STATUS = {
  ok: { fill: "#93C5FD", stroke: "#2563EB", text: "#1E3A8A" },
  warning: { fill: "#FCD34D", stroke: "#D97706", text: "#92400E" },
  critical: { fill: "#FCA5A5", stroke: "#DC2626", text: "#991B1B" },
};

export default function GainAngleChart({ standardX, standardY, standardPoints, points, avgX, avgY, count, thresholds }) {
  // Average Gain X is only comparable when both use the same set of points
  const sameCount = !standardPoints?.length || standardPoints.length === (points?.length || 0);
  const warnPct = Number(thresholds?.warning) || 5;
  const critPct = Number(thresholds?.critical) || 10;
  const [activeIdx, setActiveIdx] = useState(null); // point whose label is shown on hover/tap
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const svgRef = useRef(null);

  const sx = parseFloat(standardX), sy = parseFloat(standardY);
  const hasStandardX = !isNaN(sx);
  const hasStandardY = !isNaN(sy);
  const hasAvgX = avgX !== null && !isNaN(avgX);
  const hasAvgY = avgY !== null && !isNaN(avgY);

  const totalPoints = points?.length || 0;
  const series = (points || []).map((p, i) => {
    const yVal = parseFloat(p.y);
    return { idx: i + 1, x: p.x, y: p.y, yVal: isNaN(yVal) ? null : yVal };
  });
  const validSeries = series.filter(p => p.yVal !== null);

  // Optional per-point standard values (same shape as `points`) — when there
  // are enough of them, the standard is drawn as a curve instead of a single
  // flat line, so a standard that was entered as a real tire-like profile
  // actually reads as one on the chart.
  const stdFn = makeStandardFn(standardPoints, standardY);
  const hasStandardCurve = stdFn.curve;
  const axisN = Math.max(totalPoints, 2);
  // Standard sampled finely across the measured axis (#1 … #N) — works for any point count
  const stdSamples = hasStandardCurve
    ? Array.from({ length: 81 }, (_, k) => {
        const t = k / 80;
        return { idxF: 1 + t * (axisN - 1), yVal: stdFn.at(t) };
      })
    : [];

  const diff = (hasStandardY && hasAvgY) ? (avgY - sy) : null;
  const diffPercent = (diff !== null && sy !== 0) ? (Math.abs(diff) / Math.abs(sy)) * 100 : null;
  const diffX = (hasStandardX && hasAvgX && sameCount) ? (avgX - sx) : null;
  const diffXPercent = (diffX !== null && sx !== 0) ? (Math.abs(diffX) / Math.abs(sx)) * 100 : null;

  // Reference (standard) value for each point index: the matching per-point
  // standard when a standard curve exists, otherwise the standard's average.
  const refYAt = (idx) => {
    const v = stdFn.at(positionOf(idx - 1, totalPoints));
    return v !== null ? v : (hasStandardY ? sy : null);
  };
  const pointDev = (p) => {
    const ref = refYAt(p.idx);
    if (ref === null || ref === 0) return { ref, pct: null, status: "ok" };
    const pct = (Math.abs(p.yVal - ref) / Math.abs(ref)) * 100;
    const status = pct > critPct ? "critical" : pct >= warnPct ? "warning" : "ok";
    return { ref, pct, status };
  };
  const devs = validSeries.map(pointDev);
  const warnCount = devs.filter(d => d.status === "warning").length;
  const diagnosis = diagnoseProfile({ points, standardPoints, standardY, thresholds });
  const critCount = devs.filter(d => d.status === "critical").length;

  // Tolerance band around the standard (per point index across the whole axis)
  const bandIdxs = Array.from({ length: axisN }, (_, i) => i + 1);
  const bandRefs = bandIdxs.map(i => ({ idx: i, ref: refYAt(i) })).filter(b => b.ref !== null && b.ref !== 0);
  const bandAt = (pct, sign) => bandRefs.map(b => ({ idx: b.idx, y: b.ref + sign * Math.abs(b.ref) * pct / 100 }));

  // Base (zoom = 1) data bounds. X = point index; Y = raw Gain Y value.
  const rawMinXIdx = 1, rawMaxXIdx = Math.max(totalPoints, 2);
  const allY = [
    ...(hasStandardY ? [sy] : []),
    ...(hasAvgY ? [avgY] : []),
    ...validSeries.map(p => p.yVal),
    ...stdSamples.map(p => p.yVal),
    ...bandAt(critPct, 1).map(b => b.y),
    ...bandAt(critPct, -1).map(b => b.y),
  ];
  // Keep the Y axis at least ±20% around the standard, so a 1–2% difference
  // looks small instead of being blown up to fill the whole chart.
  if (hasStandardY && sy !== 0) {
    allY.push(sy - Math.abs(sy) * 0.2, sy + Math.abs(sy) * 0.2);
  }
  const rawMinY = allY.length ? Math.min(...allY) : -1;
  const rawMaxY = allY.length ? Math.max(...allY) : 1;
  const rangeY = (rawMaxY - rawMinY) || 1;
  const baseMinX = rawMinXIdx - 0.6, baseMaxX = rawMaxXIdx + 0.6;
  const baseMinY = rawMinY - rangeY * 0.12, baseMaxY = rawMaxY + rangeY * 0.12;
  const baseCenterX = (baseMinX + baseMaxX) / 2, baseCenterY = (baseMinY + baseMaxY) / 2;
  const baseHalfW = (baseMaxX - baseMinX) / 2, baseHalfH = (baseMaxY - baseMinY) / 2;

  // X axis is just the point order (#1..#N) — always shown in full; zoom/pan are vertical only
  const halfW = baseHalfW, halfH = baseHalfH / zoom;
  // Clamp how far the view can be dragged, so panning can never scroll the
  // data out of view entirely — the visible window is always kept within the
  // original (zoom = 1) bounds of the chart.
  const maxPanX = Math.max(0, baseHalfW - halfW);
  const maxPanY = Math.max(0, baseHalfH - halfH);
  const clampedPanX = 0;
  const clampedPanY = Math.min(maxPanY, Math.max(-maxPanY, pan.y));
  const panCenterX = baseCenterX + clampedPanX, panCenterY = baseCenterY + clampedPanY;
  const minX = panCenterX - halfW, maxX = panCenterX + halfW;
  const minY = panCenterY - halfH, maxY = panCenterY + halfH;

  // Enlarged default canvas (was 520x300) so the chart reads clearly at a glance
  // without needing to zoom in first. Width still stretches to fill its container
  // (see width="100%" on the <svg> below) — this mainly grows the rendered height
  // and keeps text/markers proportioned to the bigger canvas.
  const size = 760, height = 440, margin = 56;
  const plotW = size - margin * 2, plotH = height - margin * 2;

  const toPx = (x, y) => ({
    px: margin + ((x - minX) / (maxX - minX)) * plotW,
    py: margin + (1 - (y - minY) / (maxY - minY)) * plotH,
  });

  const { ticks: yTicks, step: yStep } = niceTicks(minY, maxY);

  const clampZoom = z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const zoomIn = () => setZoom(z => clampZoom(z * 1.5));
  const zoomOut = () => setZoom(z => clampZoom(z / 1.5));
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const isDefaultView = zoom === 1 && clampedPanX === 0 && clampedPanY === 0;

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom(z => clampZoom(z * factor));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const pxPerUnitX = plotW / (maxX - minX);
  const pxPerUnitY = plotH / (maxY - minY);

  const handlePointerDown = (e) => {
    // Tapping a point shows its value — don't turn that into a drag.
    // At zoom 1 there's nothing to pan, so leave touches alone (lets the page scroll on phones).
    if (e.target.closest?.("[data-pt]") || zoom <= 1) return;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = { startClientX: e.clientX, startClientY: e.clientY, startPan: pan, pxPerUnitX, pxPerUnitY };
  };
  const handlePointerMove = (e) => {
    if (!dragRef.current) return;
    const { startClientX, startClientY, startPan, pxPerUnitX: ppuX, pxPerUnitY: ppuY } = dragRef.current;
    const dPx = e.clientX - startClientX, dPy = e.clientY - startClientY;
    // Store the raw (unclamped) drag offset — clamping happens once, on render,
    // via clampedPanX/clampedPanY above, so this stays simple and always in sync.
    setPan({ x: 0, y: startPan.y + dPy / ppuY });
  };
  const handlePointerUp = (e) => {
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  const stdPy = hasStandardY ? toPx(0, sy).py : null;
  const avgPy = hasAvgY ? toPx(0, avgY).py : null;

  const linePoints = validSeries.map(p => toPx(p.idx, p.yVal));
  // Measured values: straight segments between points — only what was actually
  // measured, no invented bumps between points. (The standard stays a smooth
  // curve because it represents the wheel's intended profile.)
  const measuredPathStr = linePoints.map((pt, i) => `${i ? "L" : "M"}${pt.px},${pt.py}`).join(" ");
  const stdLinePoints = stdSamples.map(p => toPx(p.idxF, p.yVal));
  const stdSmoothPathStr = stdLinePoints.map((pt, i) => `${i ? "L" : "M"}${pt.px.toFixed(2)},${pt.py.toFixed(2)}`).join(" ");

  // Closed band shape: upper edge left→right, then lower edge right→left
  const bandPath = (pct) => {
    const up = bandAt(pct, 1).map(b => toPx(b.idx, b.y));
    const lo = bandAt(pct, -1).map(b => toPx(b.idx, b.y)).reverse();
    if (up.length < 2) return "";
    // Same smooth curve as the standard line, scaled ±pct — so the band follows
    // the standard exactly and starts/ends at the same points (#1 … #N).
    const upP = smoothPathFromPoints(up);
    const loP = smoothPathFromPoints(lo).replace(/^M/, "L");
    return `${upP} ${loP} Z`;
  };

  // ---- Cross-section view geometry ----
  // Standard profile = the "new tyre" outline; filled down to the bottom of the plot
  const plotTop = margin, plotBottom = height - margin;
  const stdOutlinePts = hasStandardCurve
    ? stdLinePoints
    : (stdPy !== null && totalPoints >= 1
        ? [toPx(1, sy), toPx(Math.max(totalPoints, 2), sy)]
        : []);
  const stdOutline = hasStandardCurve ? stdSmoothPathStr
    : stdOutlinePts.length === 2 ? `M${stdOutlinePts[0].px},${stdOutlinePts[0].py} L${stdOutlinePts[1].px},${stdOutlinePts[1].py}` : "";
  const closeTo = (path, pts, yEdge) => (path && pts.length >= 2)
    ? `${path} L${pts[pts.length - 1].px},${yEdge} L${pts[0].px},${yEdge} Z` : "";
  const stdBodyPath = closeTo(stdOutline, stdOutlinePts, plotBottom + 40);
  const stdAbovePath = closeTo(stdOutline, stdOutlinePts, plotTop - 40);
  const measUnderPath = closeTo(measuredPathStr, linePoints, plotBottom + 40);
  const measAbovePath = closeTo(measuredPathStr, linePoints, plotTop - 40);

  // Biggest wear (most negative deviation) for the summary badge
  const worst = validSeries.reduce((acc, p, i) => {
    const ref = devs[i].ref;
    if (!ref) return acc;
    const v = ((p.yVal - ref) / Math.abs(ref)) * 100;
    return !acc || v < acc.v ? { idx: p.idx, v } : acc;
  }, null);

  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>
            โปรไฟล์หน้ายาง (ภาพตัดขวาง) เทียบกับมาตรฐาน
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>วัดจากขอบซ้าย → ขอบขวา · กรอกแล้ว {count || 0}/{totalPoints} จุด</div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: isDefaultView ? "#cbd5e1" : "#2563EB", fontWeight: 700, minWidth: 34, textAlign: "right" }}>
            {Math.round(zoom * 100)}%
          </span>
          <button onClick={zoomOut} title="ซูมออก" disabled={zoom <= ZOOM_MIN}
            style={{ ...zoomBtnStyle, opacity: zoom <= ZOOM_MIN ? 0.4 : 1 }}>−</button>
          <button onClick={zoomIn} title="ซูมเข้า" disabled={zoom >= ZOOM_MAX}
            style={{ ...zoomBtnStyle, opacity: zoom >= ZOOM_MAX ? 0.4 : 1 }}>+</button>
          <button onClick={resetView} title={isDefaultView ? "อยู่ที่มุมมองปกติแล้ว" : "กลับสู่มุมมองปกติ"} disabled={isDefaultView}
            style={{
              ...zoomBtnStyle, width: "auto", padding: "0 8px", fontSize: 10,
              ...(isDefaultView
                ? { opacity: 0.4, cursor: "default" }
                : { background: "#2563EB", color: "#fff", borderColor: "#2563EB" }),
            }}>
            รีเซ็ต
          </button>
        </div>
      </div>

      {/* Reference-value badges live OUTSIDE the plot canvas entirely — they can
          never end up sitting on top of a data point no matter what the values
          are or how the chart is zoomed. */}
      {(hasStandardY || hasAvgY) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {validSeries.length > 0 && bandRefs.length > 0 && (
            critCount + warnCount === 0 ? (
              <span style={{ ...badgeStyle, color: "#166534", background: "#DCFCE7", borderColor: "#BBF7D0" }}>
                ✅ ทุกจุดอยู่ในเกณฑ์ (±{warnPct}%)
              </span>
            ) : (
              <>
                {critCount > 0 && (
                  <span style={{ ...badgeStyle, color: "#991B1B", background: "#FEE2E2", borderColor: "#FECACA" }}>
                    🔴 เกิน {critPct}% · {critCount} จุด
                  </span>
                )}
                {warnCount > 0 && (
                  <span style={{ ...badgeStyle, color: "#92400E", background: "#FEF3C7", borderColor: "#FDE68A" }}>
                    ⚠️ {warnPct}–{critPct}% · {warnCount} จุด
                  </span>
                )}
              </>
            )
          )}
          {worst && worst.v < -warnPct && (
            <span style={{ ...badgeStyle, color: "#991B1B", background: "#FFF1F2", borderColor: "#FECDD3" }}>
              สึกมากสุดที่ #{worst.idx} ({worst.v.toFixed(1)}%)
            </span>
          )}
          {hasStandardY && (
            <span style={{
              fontSize: 10.5, fontWeight: 700, color: "#475569", background: "#F1F5F9",
              border: "1px solid #E2E8F0", borderRadius: 999, padding: "3px 10px",
            }}>
              มาตรฐาน {sy.toFixed(2)}
            </span>
          )}
          {hasAvgY && (
            <span style={{
              fontSize: 10.5, fontWeight: 700, color: "#92400E", background: "#FEF3C7",
              border: "1px solid #FDE68A", borderRadius: 999, padding: "3px 10px",
            }}>
              เฉลี่ยที่วัดได้ {avgY.toFixed(2)}
            </span>
          )}
        </div>
      )}

      <svg
        ref={svgRef}
        width="100%" viewBox={`0 0 ${size} ${height}`}
        style={{
          touchAction: zoom > 1 ? "none" : "pan-y", cursor: zoom > 1 ? "grab" : "default", userSelect: "none", WebkitUserSelect: "none", background: "#fcfdff", borderRadius: 8, display: "block",
          height: "auto", aspectRatio: `${size} / ${height}`,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <defs>
          <clipPath id="gac-clip">
            <rect x={margin} y={margin} width={plotW} height={plotH} />
          </clipPath>
          {measAbovePath && <clipPath id={`${uid}-measAbove`}><path d={measAbovePath} /></clipPath>}
          {stdAbovePath && <clipPath id={`${uid}-stdAbove`}><path d={stdAbovePath} /></clipPath>}
          <pattern id={`${uid}-rubber`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="8" height="8" fill="#E2E8F0" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="#CBD5E1" strokeWidth="1.2" />
          </pattern>
        </defs>

        {/* Y grid lines with round-number labels */}
        {yTicks.map((t, i) => {
          const { py } = toPx(0, t);
          return (
            <g key={`gy-${i}`}>
              <line x1={margin} y1={py} x2={size - margin} y2={py} stroke="#eef2f7" strokeWidth="1" />
              <text x={margin - 8} y={py + 3.5} fontSize="10.5" fill="#94a3b8" textAnchor="end">{fmtTick(t, yStep)}</text>
            </g>
          );
        })}
        <text x={14} y={margin + plotH / 2} fontSize="10.5" fill="#94a3b8" textAnchor="middle"
          transform={`rotate(-90 14 ${margin + plotH / 2})`}>Gain Y</text>

        {/* X grid lines — a faint vertical line through each point index, like
            graph paper, so it's easy to trace straight up/down to read a
            point's Y value off the axis */}
        {series.map((p) => {
          const { px } = toPx(p.idx, 0);
          if (px < margin - 1 || px > size - margin + 1) return null;
          return (
            <line key={`gx-${p.idx}`} x1={px} y1={margin} x2={px} y2={height - margin}
              stroke="#f1f5f9" strokeWidth="1" />
          );
        })}

        {/* 0 reference line — the one fixed anchor so up/down orientation is never ambiguous,
            especially when most values are negative */}
        {minY <= 0 && 0 <= maxY && (() => {
          const { py } = toPx(0, 0);
          return (
            <g>
              <line x1={margin} y1={py} x2={size - margin} y2={py} stroke="#cbd5e1" strokeWidth="1.3" />
            </g>
          );
        })()}

        {/* edge markers: which side is which */}
        {totalPoints >= 2 && (() => {
          const l = toPx(1, 0).px, r = toPx(totalPoints, 0).px;
          return (
            <g fontSize="10" fill="#64748B" fontWeight="700">
              {l >= margin - 1 && <text x={l} y={height - margin + 34} textAnchor="middle">◀ ขอบซ้าย</text>}
              {r <= size - margin + 1 && <text x={r} y={height - margin + 34} textAnchor="middle">ขอบขวา ▶</text>}
            </g>
          );
        })()}

        {/* X axis labels — point index */}
        {series.map((p) => {
          const { px } = toPx(p.idx, minY);
          if (px < margin - 1 || px > size - margin + 1) return null;
          return (
            <text key={`xt-${p.idx}`} x={px} y={height - margin + 18} fontSize="10.5" fill="#94a3b8" textAnchor="middle">
              #{p.idx}
            </text>
          );
        })}

        <g clipPath="url(#gac-clip)">
          {/* 1) the standard ("new tyre") cross-section — hatched rubber body */}
          {stdBodyPath && <path d={stdBodyPath} fill={`url(#${uid}-rubber)`} />}

          {/* 2) WORN area: inside the standard body but above the measured line → red */}
          {stdBodyPath && measAbovePath && (
            <path d={stdBodyPath} fill="#F87171" opacity="0.55" clipPath={`url(#${uid}-measAbove)`} />
          )}
          {/* 3) BULGE area: under the measured line but above the standard → amber */}
          {measUnderPath && stdAbovePath && (
            <path d={measUnderPath} fill="#FBBF24" opacity="0.5" clipPath={`url(#${uid}-stdAbove)`} />
          )}

          {/* standard outline */}
          {stdOutline && (
            <path d={stdOutline} fill="none" stroke="#475569" strokeWidth="2.4"
              strokeLinejoin="round" strokeLinecap="round" />
          )}
          {linePoints.length > 1 && (
            <path d={measuredPathStr} fill="none" stroke="#2563EB" strokeWidth="2.2"
              strokeLinejoin="round" strokeLinecap="round" />
          )}

          {/* each measured point — colored by how far it is from the standard */}
          {validSeries.map((p, i) => {
            const { px, py } = toPx(p.idx, p.yVal);
            const st = POINT_STATUS[devs[i].status];
            return (
              <g key={p.idx} data-pt="1"
                onPointerEnter={() => setActiveIdx(p.idx)}
                onPointerLeave={() => setActiveIdx(cur => (cur === p.idx ? null : cur))}
                onClick={() => setActiveIdx(cur => (cur === p.idx ? null : p.idx))}
                style={{ cursor: "pointer" }}
              >
                <circle cx={px} cy={py} r="13" fill="transparent" />
                <circle cx={px} cy={py} r={activeIdx === p.idx ? 7 : 5.5}
                  fill={st.fill} stroke={st.stroke} strokeWidth="1.4" />
              </g>
            );
          })}
        </g>

        {/* Labels drawn outside the clip so they're never cut at the edges.
            Only out-of-tolerance points (and the hovered/tapped one) get a label.
            Placement is greedy: the hovered point first, then the biggest deviation;
            each label tries above, then below its point, and is skipped if it would
            overlap a label already placed (the point stays colored — hover/tap shows it). */}
        {(() => {
          const candidates = validSeries
            .map((p, i) => ({ p, d: devs[i] }))
            .filter(({ p }) => activeIdx === p.idx)
            .sort((a, b) => {
              if (a.p.idx === activeIdx) return -1;
              if (b.p.idx === activeIdx) return 1;
              return (b.d.pct ?? 0) - (a.d.pct ?? 0);
            });
          const placed = [];
          const pointBoxes = linePoints.map(pt => ({ x1: pt.px - 6, x2: pt.px + 6, y1: pt.py - 6, y2: pt.py + 6 }));
          const hit = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
          const out = [];
          for (const { p, d } of candidates) {
            const { px, py } = toPx(p.idx, p.yVal);
            if (px < margin - 1 || px > size - margin + 1 || py < margin - 1 || py > height - margin + 1) continue;
            const line1 = `#${p.idx} Y=${p.yVal}${d.pct !== null ? ` (${d.pct.toFixed(1)}%)` : ""}`;
            const line2 = `X=${p.x || p.idx}${d.ref !== null ? ` · มาตรฐาน ${+d.ref.toFixed(3)}` : ""}`;
            const w = Math.max(line1.length * 6.4, line2.length * 5.2) + 6;
            const anchor = px < margin + w / 2 ? "start" : px > size - margin - w / 2 ? "end" : "middle";
            const x1 = anchor === "start" ? px - 3 : anchor === "end" ? px - w + 3 : px - w / 2;
            const isActive = p.idx === activeIdx;
            let spot = null;
            for (const below of [false, true]) {
              const ty = below ? py + 20 : py - 20;
              const box = { x1, x2: x1 + w, y1: ty - 11, y2: ty + 14 };
              if (box.y1 < 4 || box.y2 > height - 4) continue;
              const blocked = placed.some(b => hit(b, box))
                || (!isActive && pointBoxes.some(b => hit(b, box)));
              if (!blocked || isActive) { spot = { ty, box }; break; }
            }
            if (!spot) continue;
            placed.push(spot.box);
            const st = POINT_STATUS[d.status];
            out.push(
              <g key={`lbl-${p.idx}`} pointerEvents="none">
                <text x={px} y={spot.ty} fontSize="11" fill={st.text} textAnchor={anchor} fontWeight="700"
                  stroke="#fff" strokeWidth="3" paintOrder="stroke">{line1}</text>
                <text x={px} y={spot.ty + 11} fontSize="9" fill={st.stroke} textAnchor={anchor}
                  stroke="#fff" strokeWidth="3" paintOrder="stroke">{line2}</text>
              </g>
            );
          }
          return out;
        })()}
      </svg>

      {/* Deviation panel — % difference of each point from ITS OWN standard value,
          on a fixed scale with the ±warning / ±critical limits. This is how QC
          reports usually show a profile check: easy to read even when the raw
          values are far apart in scale. Shares the X axis (and zoom/pan) above. */}
      {bandRefs.length > 0 && validSeries.length > 0 && (() => {
        const devH = 190, top = 22, bottom = 30;
        const pH = devH - top - bottom;
        const signed = validSeries.map((p, i) => {
          const ref = devs[i].ref;
          return ref ? ((p.yVal - ref) / Math.abs(ref)) * 100 : null;
        });
        const maxAbs = Math.max(0, ...signed.filter(v => v !== null).map(Math.abs));
        // fixed, readable scale: at least ±1.5× the critical limit, at most ±50%
        const R = Math.min(50, Math.max(critPct * 1.5, Math.ceil(maxAbs * 1.15)));
        const yOf = v => top + (1 - (Math.max(-R, Math.min(R, v)) + R) / (2 * R)) * pH;
        const xOf = idx => toPx(idx, 0).px;
        const step = R <= 15 ? 5 : R <= 30 ? 10 : 25;
        const ticks = [];
        for (let v = -Math.floor(R / step) * step; v <= R; v += step) ticks.push(v);
        const barW = Math.max(6, Math.min(26, (plotW / Math.max(totalPoints, 1)) * 0.5));
        return (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", margin: "0 0 4px 2px" }}>
              % เบี่ยงจากมาตรฐาน รายจุด
              <span style={{ fontWeight: 500, color: "#94a3b8", fontSize: 11 }}> · บวก = สูงกว่ามาตรฐาน, ลบ = ต่ำกว่า</span>
            </div>
            <svg width="100%" viewBox={`0 0 ${size} ${devH}`}
              style={{ display: "block", background: "#fcfdff", borderRadius: 8, height: "auto", aspectRatio: `${size} / ${devH}` }}>
              <defs>
                <clipPath id="gac-dev-clip"><rect x={margin} y={top} width={plotW} height={pH} /></clipPath>
              </defs>
              {/* limit bands */}
              <rect x={margin} y={yOf(critPct)} width={plotW} height={yOf(-critPct) - yOf(critPct)} fill="#FEF3C7" opacity="0.75" />
              <rect x={margin} y={yOf(warnPct)} width={plotW} height={yOf(-warnPct) - yOf(warnPct)} fill="#DCFCE7" opacity="0.9" />
              {ticks.map(v => (
                <g key={`dt-${v}`}>
                  <line x1={margin} x2={size - margin} y1={yOf(v)} y2={yOf(v)}
                    stroke={v === 0 ? "#64748B" : "#eef2f7"} strokeWidth={v === 0 ? 1.6 : 1} />
                  <text x={margin - 8} y={yOf(v) + 3.5} fontSize="10.5" textAnchor="end"
                    fill={v === 0 ? "#475569" : "#94a3b8"} fontWeight={v === 0 ? 700 : 400}>
                    {v > 0 ? `+${v}` : v}%
                  </text>
                </g>
              ))}
              {[warnPct, -warnPct, critPct, -critPct].map(v => (
                <line key={`lim-${v}`} x1={margin} x2={size - margin} y1={yOf(v)} y2={yOf(v)}
                  stroke={Math.abs(v) === critPct ? "#F59E0B" : "#86EFAC"} strokeWidth="1" strokeDasharray="4 3" />
              ))}
              <g clipPath="url(#gac-dev-clip)">
                {validSeries.map((p, i) => {
                  const v = signed[i];
                  if (v === null) return null;
                  const x = xOf(p.idx);
                  const y0 = yOf(0), y1 = yOf(v);
                  const st = POINT_STATUS[devs[i].status];
                  const isActive = activeIdx === p.idx;
                  return (
                    <rect key={`bar-${p.idx}`} x={x - barW / 2} width={barW}
                      y={Math.min(y0, y1)} height={Math.max(1.5, Math.abs(y1 - y0))}
                      fill={st.fill} stroke={st.stroke} strokeWidth={isActive ? 2 : 1} rx="2"
                      style={{ cursor: "pointer" }}
                      onPointerEnter={() => setActiveIdx(p.idx)}
                      onPointerLeave={() => setActiveIdx(cur => (cur === p.idx ? null : cur))}
                      onClick={() => setActiveIdx(cur => (cur === p.idx ? null : p.idx))} />
                  );
                })}
              </g>
              {/* off-scale markers: a small arrow at the clipped end of the bar */}
              {validSeries.map((p, i) => {
                const v = signed[i];
                if (v === null || Math.abs(v) <= R) return null;
                const x = xOf(p.idx);
                const yE = v > 0 ? top : top + pH;
                const d = v > 0
                  ? `M${x - 5},${yE + 7} L${x},${yE} L${x + 5},${yE + 7} Z`
                  : `M${x - 5},${yE - 7} L${x},${yE} L${x + 5},${yE - 7} Z`;
                return <path key={`ar-${p.idx}`} d={d} fill="#DC2626" pointerEvents="none" />;
              })}
              {/* value labels: hovered bar first, then largest deviations; a label is
                  skipped if it would overlap one already placed (hover/tap still shows it) */}
              {(() => {
                const order = validSeries
                  .map((p, i) => ({ p, i, v: signed[i] }))
                  .filter(({ p, i, v }) => v !== null && (devs[i].status !== "ok" || activeIdx === p.idx))
                  .sort((a, b) => (a.p.idx === activeIdx ? -1 : b.p.idx === activeIdx ? 1 : Math.abs(b.v) - Math.abs(a.v)));
                const placed = [];
                const out = [];
                for (const { p, i, v } of order) {
                  const x = xOf(p.idx);
                  if (x < margin - 1 || x > size - margin + 1) continue;
                  const label = `${v > 0 ? "+" : ""}${Math.round(v)}%`;
                  const w = label.length * 6.2 + 4;
                  const up = v >= 0;
                  const off = Math.abs(v) > R;
                  const y = off ? (up ? top - 6 : top + pH + 14) : up ? yOf(v) - 5 : yOf(v) + 13;
                  const box = { x1: x - w / 2, x2: x + w / 2, y1: y - 10, y2: y + 2 };
                  if (p.idx !== activeIdx && placed.some(b => b.x1 < box.x2 && b.x2 > box.x1 && b.y1 < box.y2 && b.y2 > box.y1)) continue;
                  placed.push(box);
                  const st = POINT_STATUS[devs[i].status];
                  out.push(
                    <text key={`bl-${p.idx}`} x={x} y={y} fontSize="10" fontWeight="700" fill={st.text}
                      textAnchor="middle" stroke="#fff" strokeWidth="3" paintOrder="stroke" pointerEvents="none">
                      {label}
                    </text>
                  );
                }
                return out;
              })()}
              {series.map(p => {
                const x = xOf(p.idx);
                if (x < margin - 1 || x > size - margin + 1) return null;
                return (
                  <text key={`dx-${p.idx}`} x={x} y={devH - 8} fontSize="10.5" fill={activeIdx === p.idx ? "#1E3A8A" : "#94a3b8"}
                    fontWeight={activeIdx === p.idx ? 700 : 400} textAnchor="middle">#{p.idx}</text>
                );
              })}
            </svg>
          </div>
        );
      })()}

      {diagnosis.level && (() => {
        const tone = {
          critical: { bg: "#FEF2F2", border: "#FECACA", head: "#991B1B" },
          warning: { bg: "#FFFBEB", border: "#FDE68A", head: "#92400E" },
          ok: { bg: "#F0FDF4", border: "#BBF7D0", head: "#166534" },
        }[diagnosis.level];
        const dot = { ok: "#16A34A", warn: "#D97706", bad: "#DC2626", info: "#64748B" };
        return (
          <div style={{
            marginTop: 12, background: tone.bg, border: `1px solid ${tone.border}`,
            borderRadius: 10, padding: "10px 12px",
          }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#334155", marginBottom: 4 }}>📋 สรุปอาการจากกราฟ</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: tone.head, marginBottom: 6 }}>{diagnosis.verdict}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {diagnosis.findings.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: "#334155", lineHeight: 1.5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: dot[f.tone], marginTop: 6, flexShrink: 0 }} />
                  <span>{f.text}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <div style={{ fontSize: 12, color: "#475569", marginTop: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 8 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#334155" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#E2E8F0", border: "2px solid #475569", boxSizing: "border-box", flexShrink: 0 }} />
              มาตรฐาน (ยางใหม่)
            </div>
            <div style={{ marginLeft: 16 }}>
              Gain X: {hasStandardX ? +sx.toFixed(3) : "—"} &nbsp; Gain Y: {hasStandardY ? sy.toFixed(3) : "—"}
            </div>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#334155" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#F87171", opacity: 0.7, flexShrink: 0 }} />
              ส่วนที่สึก (ต่ำกว่ามาตรฐาน)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#334155", marginTop: 2 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#FBBF24", opacity: 0.7, flexShrink: 0 }} />
              ส่วนที่นูน (สูงกว่ามาตรฐาน)
            </div>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#92400E" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#D97706", flexShrink: 0 }} />
              ค่าเฉลี่ยที่วัดได้
            </div>
            <div style={{ marginLeft: 16 }}>
              Gain X: {hasAvgX ? avgX.toFixed(3) : "—"} &nbsp; Gain Y: {hasAvgY ? avgY.toFixed(3) : "—"}
            </div>
          </div>
        </div>

        {(diff !== null || diffX !== null) ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {diffX !== null && (
              <div style={{
                padding: "8px 10px", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0",
                fontWeight: 700, color: "#0f172a", fontSize: 13, display: "inline-block",
              }}>
                Gain X เปลี่ยนไป {Math.abs(diffX).toFixed(3)}
                {diffXPercent !== null && ` (${diffXPercent.toFixed(1)}%)`}
              </div>
            )}
            {diff !== null && (
              <div style={{
                padding: "8px 10px", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0",
                fontWeight: 700, color: "#0f172a", fontSize: 13, display: "inline-block",
              }}>
                Gain Y เปลี่ยนไป {Math.abs(diff).toFixed(3)}
                {diffPercent !== null && ` (${diffPercent.toFixed(1)}%)`}
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: "#94a3b8", fontSize: 11 }}>
            กรอกค่ามาตรฐานและค่าที่วัดอย่างน้อย 1 จุดเพื่อคำนวณ
          </div>
        )}
        <div style={{ fontSize: 9.5, color: "#cbd5e1", marginTop: 8 }}>
          ชี้/แตะที่จุดหรือแท่งเพื่อดูค่า · สีเหลือง/แดง = หลุดเกณฑ์ · กราฟล่างแสดง % เบี่ยงของแต่ละจุดเทียบกับมาตรฐานของจุดนั้น · scroll/ปุ่ม +− เพื่อซูมแนวตั้ง (ซูมแล้วลากขึ้น-ลงได้)
        </div>
      </div>
    </div>
  );
}

const badgeStyle = {
  fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "3px 10px",
  border: "1px solid transparent",
};

const zoomBtnStyle = {
  width: 22, height: 22, border: "1px solid #e2e8f0", borderRadius: 6,
  background: "#f8fafc", color: "#475569", fontSize: 13, fontWeight: 700,
  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
  padding: 0, fontFamily: "inherit",
};
