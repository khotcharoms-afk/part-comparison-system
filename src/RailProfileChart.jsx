import { useState, useRef, useEffect, useId } from "react";

/*
 * Railway wheel profile chart (MiniProf-style), all in mm.
 *  • dashed line  = standard (new wheel) profile
 *  • solid line   = measured profile
 *  • dotted vertical line splits Flange (left) / Tread (right)
 *  • Tread Wear  = VERTICAL gap between the profiles at a fixed X  (default X = 70 mm)
 *  • Flange Wear = HORIZONTAL gap between the profiles at a fixed height (default Y = 10 mm)
 *  • limit points (e.g. SRT Flange Wear Limit) — exceeded when the measured surface
 *    drops below the point at that X (material worn past the point)
 */

export const DEFAULT_RAIL = {
  treadX: 70,
  flangeY: 10,
  boundaryX: 35,
  treadWarn: 2,
  treadCrit: 4,
  flangeWarn: 1,
  flangeCrit: 2,
  limits: [
    { label: "SRT Flange Wear Limit", x: 23.65, y: 8.85 },
    { label: "SRT Flange Root Limit", x: 24.95, y: 3.75 },
  ],
};

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

export function railSettings(rail) {
  const r = { ...DEFAULT_RAIL, ...(rail || {}) };
  for (const k of ["treadX", "flangeY", "boundaryX", "treadWarn", "treadCrit", "flangeWarn", "flangeCrit"]) {
    r[k] = num(r[k]) ?? DEFAULT_RAIL[k];
  }
  r.limits = (Array.isArray(r.limits) ? r.limits : [])
    .map(l => ({ label: String(l?.label || "Limit"), x: num(l?.x), y: num(l?.y) }))
    .filter(l => l.x !== null && l.y !== null);
  return r;
}

// points → sorted polyline [{x, y}] (only points with both X and Y)
export function toPolyline(points) {
  return (points || [])
    .map(p => ({ x: num(p?.x), y: num(p?.y) }))
    .filter(p => p.x !== null && p.y !== null)
    .sort((a, b) => a.x - b.x);
}

// linear interpolation of Y at X (null outside the measured range)
export function yAt(poly, x) {
  if (poly.length < 2 || x < poly[0].x || x > poly[poly.length - 1].x) return null;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    if (x >= a.x && x <= b.x) {
      if (b.x === a.x) return a.y;
      return a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
    }
  }
  return null;
}

// first X (scanning from the left, only up to xMax) where the profile crosses height y
export function xAtY(poly, y, xMax) {
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    if (a.x > xMax) break;
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) {
      return a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
    }
  }
  return null;
}

const LEVEL_RANK = { ok: 0, warning: 1, critical: 2 };
const levelOf = (v, warn, crit) => (v === null ? null : v > crit ? "critical" : v >= warn ? "warning" : "ok");
const f2 = v => (v === null || v === undefined ? "—" : v.toFixed(2));

/**
 * Railway wheel diagnosis. Returns
 * { level, verdict, findings: [{tone, text}], treadWear, flangeWear, limits: [...],
 *   treadLevel, flangeLevel, std: {treadY, flangeX}, meas: {treadY, flangeX}, maxTread }
 */
export function diagnoseRail({ points, standardPoints, rail }) {
  const r = railSettings(rail);
  const S = toPolyline(standardPoints);
  const M = toPolyline(points);
  const empty = { level: null, verdict: "", findings: [], treadWear: null, flangeWear: null, limits: [] };
  if (S.length < 2 || M.length < 1) return empty;

  const sTreadY = yAt(S, r.treadX);
  const mTreadY = yAt(M, r.treadX);
  const treadWear = sTreadY !== null && mTreadY !== null ? sTreadY - mTreadY : null;

  const flankMax = r.boundaryX + 10;
  const sFlangeX = xAtY(S, r.flangeY, flankMax);
  const mFlangeX = M.length >= 2 ? xAtY(M, r.flangeY, flankMax) : null;
  // flange face moving left (towards the flange back) = thinner flange = wear
  const flangeWear = sFlangeX !== null && mFlangeX !== null ? sFlangeX - mFlangeX : null;

  const limits = r.limits.map(l => {
    const my = yAt(M, l.x);
    return { ...l, measuredY: my, exceeded: my !== null && my < l.y, checked: my !== null };
  });

  // biggest vertical loss along the tread (right of the boundary)
  let maxTread = null;
  for (const p of M) {
    if (p.x <= r.boundaryX) continue;
    const sy = yAt(S, p.x);
    if (sy === null) continue;
    const loss = sy - p.y;
    if (!maxTread || loss > maxTread.loss) maxTread = { x: p.x, loss };
  }

  const treadLevel = levelOf(treadWear === null ? null : Math.max(0, treadWear), r.treadWarn, r.treadCrit);
  const flangeLevel = levelOf(flangeWear === null ? null : Math.max(0, flangeWear), r.flangeWarn, r.flangeCrit);
  const limitLevel = limits.some(l => l.exceeded) ? "critical" : null;
  const levels = [treadLevel, flangeLevel, limitLevel].filter(Boolean);
  const level = levels.length ? levels.reduce((w, l) => (LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w), "ok") : null;

  const findings = [];
  const toneOf = l => (l === "critical" ? "bad" : l === "warning" ? "warn" : "ok");
  if (treadWear === null) {
    findings.push({ tone: "info", text: `Tread Wear: ยังวัดไม่ถึง X = ${r.treadX} mm` });
  } else {
    findings.push({
      tone: toneOf(treadLevel),
      text: `Tread Wear ${f2(treadWear)} mm ที่ X = ${r.treadX} mm (เตือน ${r.treadWarn} · วิกฤต ${r.treadCrit} mm)`,
    });
  }
  if (flangeWear === null) {
    findings.push({ tone: "info", text: `Flange Wear: ยังวัดไม่ครอบคลุมความสูง Y = ${r.flangeY} mm ที่ปีกล้อ` });
  } else {
    findings.push({
      tone: toneOf(flangeLevel),
      text: `Flange Wear ${f2(flangeWear)} mm ที่ความสูง Y = ${r.flangeY} mm (เตือน ${r.flangeWarn} · วิกฤต ${r.flangeCrit} mm)`,
    });
  }
  limits.forEach(l => {
    if (!l.checked) {
      findings.push({ tone: "info", text: `${l.label} (${l.x}, ${l.y}): ยังวัดไม่ถึง X = ${l.x} mm` });
    } else {
      findings.push({
        tone: l.exceeded ? "bad" : "ok",
        text: l.exceeded
          ? `เลย ${l.label} (${l.x}, ${l.y}) — ผิวที่วัดได้ต่ำกว่าจุดนี้ (Y = ${f2(l.measuredY)} mm)`
          : `ยังไม่ถึง ${l.label} (${l.x}, ${l.y})`,
      });
    }
  });
  if (maxTread && maxTread.loss > 0.05) {
    findings.push({ tone: "info", text: `หน้าล้อต่ำกว่ามาตรฐานมากสุด ${f2(maxTread.loss)} mm ที่ X = ${+maxTread.x.toFixed(2)} mm` });
  }

  const verdict = level === "critical" ? "🔴 เกินเกณฑ์ — ควรกลึงล้อ/เปลี่ยนล้อ หรือตรวจสอบละเอียด"
    : level === "warning" ? "⚠️ เริ่มสึก — ติดตามในรอบตรวจถัดไป"
    : level === "ok" ? "✅ อยู่ในเกณฑ์ — ใช้งานต่อได้" : "";

  return {
    level, verdict, findings, treadWear, flangeWear, limits, treadLevel, flangeLevel, maxTread,
    std: { treadY: sTreadY, flangeX: sFlangeX }, meas: { treadY: mTreadY, flangeX: mFlangeX },
    settings: r,
  };
}

/* ---------------------- ordinary (plain) wheel ---------------------- */

export const DEFAULT_PLAIN = { wearWarn: 1, wearCrit: 2 };
export function plainSettings(plain) {
  const r = { ...DEFAULT_PLAIN, ...(plain || {}) };
  r.wearWarn = num(r.wearWarn) ?? DEFAULT_PLAIN.wearWarn;
  r.wearCrit = num(r.wearCrit) ?? DEFAULT_PLAIN.wearCrit;
  return r;
}

/**
 * Ordinary wheel (no flange): vertical wear in mm at every measured X across the tread.
 * Returns { level, verdict, findings, maxWear:{x,loss}, avgWear, maxBulge:{x,bulge}, coverage }
 */
export function diagnosePlain({ points, standardPoints, plain }) {
  const r = plainSettings(plain);
  const S = toPolyline(standardPoints);
  const M = toPolyline(points);
  const empty = { level: null, verdict: "", findings: [], maxWear: null, avgWear: null, maxBulge: null, settings: r };
  if (S.length < 2 || M.length < 1) return empty;
  const x0 = S[0].x, x1 = S[S.length - 1].x;
  const rows = M.map(p => { const sy = yAt(S, p.x); return sy === null ? null : { x: p.x, loss: sy - p.y }; }).filter(Boolean);
  if (!rows.length) {
    return { ...empty, findings: [{ tone: "info", text: `จุดที่วัดอยู่นอกช่วงโปรไฟล์มาตรฐาน (X ${x0}–${x1} mm)` }] };
  }
  const zoneOf = x => { const t = (x - x0) / ((x1 - x0) || 1); return t < 1 / 3 ? "left" : t > 2 / 3 ? "right" : "center"; };
  const ZONE = { left: "ขอบซ้าย", center: "กลางหน้าล้อ", right: "ขอบขวา" };
  const fx = v => +v.toFixed(2);

  const maxWear = rows.reduce((a, b) => (b.loss > a.loss ? b : a));
  const minRow = rows.reduce((a, b) => (b.loss < a.loss ? b : a));
  const maxBulge = minRow.loss < 0 ? { x: minRow.x, bulge: -minRow.loss } : null;
  const avgWear = rows.reduce((s, q) => s + q.loss, 0) / rows.length;

  const wearLevel = levelOf(Math.max(0, maxWear.loss), r.wearWarn, r.wearCrit);
  const bulgeLevel = maxBulge ? levelOf(maxBulge.bulge, r.wearWarn, r.wearCrit) : "ok";

  const findings = [];
  const toneOf = l => (l === "critical" ? "bad" : l === "warning" ? "warn" : "ok");
  const worn = rows.filter(q => q.loss >= r.wearWarn);
  if (!worn.length) {
    findings.push({ tone: "ok", text: `ไม่พบจุดสึกเกินเกณฑ์ (สึกมากสุด ${f2(Math.max(0, maxWear.loss))} mm ที่ X = ${fx(maxWear.x)} mm)` });
  } else {
    const zones = [...new Set(worn.map(q => zoneOf(q.x)))];
    const has = z => zones.includes(z);
    const where = zones.length === 1 ? `สึกที่${ZONE[zones[0]]}`
      : has("left") && has("right") && !has("center") ? "สึกที่ขอบทั้งสองข้าง"
      : zones.length === 3 ? "สึกหลายช่วงทั่วหน้าล้อ"
      : has("left") ? "สึกจากขอบซ้ายเข้ามาถึงกลางหน้าล้อ" : "สึกจากกลางหน้าล้อไปทางขอบขวา";
    const a = Math.min(...worn.map(q => q.x)), b = Math.max(...worn.map(q => q.x));
    findings.push({
      tone: toneOf(wearLevel),
      text: `${where} ช่วง X ${fx(a)}–${fx(b)} mm · สึกมากสุด ${f2(maxWear.loss)} mm ที่ X = ${fx(maxWear.x)} mm (เตือน ${r.wearWarn} · วิกฤต ${r.wearCrit} mm)`,
    });
  }
  if (maxBulge && maxBulge.bulge >= r.wearWarn) {
    findings.push({ tone: toneOf(bulgeLevel), text: `พบผิวนูนสูงกว่ามาตรฐาน ${f2(maxBulge.bulge)} mm ที่ X = ${fx(maxBulge.x)} mm — ควรตรวจด้วยตาว่ามีรอยบวมหรือสิ่งแปลกปลอม` });
  } else {
    findings.push({ tone: "ok", text: "ไม่พบผิวนูนเกินเกณฑ์" });
  }
  // left vs right balance
  const side = z => rows.filter(q => zoneOf(q.x) === z);
  const L = side("left"), Rr = side("right");
  let imbalance = false;
  if (L.length && Rr.length) {
    const avg = a => a.reduce((s, q) => s + q.loss, 0) / a.length;
    const dLR = avg(L) - avg(Rr);
    if (Math.abs(dLR) >= r.wearWarn) {
      imbalance = true;
      findings.push({ tone: "warn", text: `สองฝั่งสึกไม่เท่ากัน — ฝั่ง${dLR > 0 ? "ซ้าย" : "ขวา"}สึกมากกว่าประมาณ ${f2(Math.abs(dLR))} mm อาจเกิดจากล้อเอียงหรือรับน้ำหนักไม่เท่ากัน` });
    }
  }
  findings.push({ tone: "info", text: `สึกเฉลี่ยทั้งหน้าล้อ ${f2(avgWear)} mm (เทียบได้ ${rows.length} จุด)` });
  const mx0 = M[0].x, mx1 = M[M.length - 1].x;
  if ((Math.min(mx1, x1) - Math.max(mx0, x0)) < (x1 - x0) * 0.9) {
    findings.push({ tone: "info", text: `วัดครอบคลุม X ${fx(Math.max(mx0, x0))}–${fx(Math.min(mx1, x1))} mm จากหน้าล้อ ${fx(x0)}–${fx(x1)} mm` });
  }
  const levels = [wearLevel, bulgeLevel, imbalance ? "warning" : null].filter(Boolean);
  const level = levels.reduce((w, l) => (LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w), "ok");
  const verdict = level === "critical" ? "🔴 เกินเกณฑ์ — ควรเปลี่ยนล้อหรือตรวจสอบละเอียด"
    : level === "warning" ? "⚠️ เริ่มสึก — ติดตามในรอบตรวจถัดไป" : "✅ อยู่ในเกณฑ์ — ใช้งานต่อได้";
  return { level, verdict, findings, maxWear, avgWear, maxBulge, wearLevel, bulgeLevel, settings: r };
}

/* ------------------------------ chart ------------------------------ */

const zoomBtnStyle = {
  width: 26, height: 26, borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff",
  color: "#334155", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0,
};

function niceTicks(min, max, count = 8) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

const STATUS = {
  ok: { fill: "#93C5FD", stroke: "#2563EB" },
  warning: { fill: "#FCD34D", stroke: "#D97706" },
  critical: { fill: "#FCA5A5", stroke: "#DC2626" },
};

export default function RailProfileChart({ standardPoints, points, rail, variant = "rail", plain }) {
  const [hover, setHover] = useState(null);
  const [exaggerate, setExaggerate] = useState(false);
  // zoom: z = 1..20 (both axes together, so true scale stays true); cx/cy = view centre in mm
  const [view, setView] = useState({ z: 1, cx: null, cy: null });
  useEffect(() => { setView({ z: 1, cx: null, cy: null }); }, [exaggerate]);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const svgRef = useRef(null);
  const geomRef = useRef(null);
  const dragRef = useRef(null);
  const isPlain = variant === "plain";
  // plain wheels: no flange/boundary/limit points
  const r = isPlain ? { ...railSettings(null), boundaryX: -Infinity, limits: [] } : railSettings(rail);
  const pl = plainSettings(plain);
  const S = toPolyline(standardPoints);
  const M = toPolyline(points);
  const d = isPlain
    ? { ...diagnosePlain({ points, standardPoints, plain }), limits: [], std: {}, meas: {} }
    : diagnoseRail({ points, standardPoints, rail });

  const size = 760, height = 460, ml = 58, mr = 24, mt = 40, mb = 52;
  const plotW = size - ml - mr, plotH = height - mt - mb;

  const xs = [...S.map(p => p.x), ...M.map(p => p.x), ...r.limits.map(l => l.x)];
  const ys = [...S.map(p => p.y), ...M.map(p => p.y), ...r.limits.map(l => l.y)];
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const padX = (xMax - xMin) * 0.03 || 1;
  const BX0 = xMin - padX, BX1 = xMax + padX;
  // "True scale": 1 mm on Y looks like 1 mm on X (as on a real cross-section), so a
  // nearly-flat tread looks flat. "Exaggerate" stretches Y to fill the plot to see small wear.
  let BY0, BY1;
  const dataSpanY = (yMax - yMin) || 1;
  if (exaggerate) {
    const padY = dataSpanY * 0.1;
    BY0 = yMin - padY; BY1 = yMax + padY;
  } else {
    const trueSpanY = (BX1 - BX0) * (plotH / plotW);         // same mm-per-pixel as X
    const spanY = Math.max(trueSpanY, dataSpanY * 1.15);
    const mid = (yMin + yMax) / 2;
    // keep the profile in the upper part of the plot, with room below for the wheel body
    BY1 = Math.max(yMax + dataSpanY * 0.08 + 0.5, mid + spanY / 2);
    BY0 = BY1 - spanY;
  }
  // visible window after zoom/pan, clamped inside the full view
  const z = view.z;
  const hw = (BX1 - BX0) / 2 / z, hh = (BY1 - BY0) / 2 / z;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const cx = clamp(view.cx ?? (BX0 + BX1) / 2, BX0 + hw, BX1 - hw);
  const cy = clamp(view.cy ?? (BY0 + BY1) / 2, BY0 + hh, BY1 - hh);
  const X0 = cx - hw, X1 = cx + hw, Y0 = cy - hh, Y1 = cy + hh;
  geomRef.current = { BX0, BX1, BY0, BY1, X0, X1, Y0, Y1, z };

  const toSvg = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { sx: ((e.clientX - rect.left) / rect.width) * size, sy: ((e.clientY - rect.top) / rect.height) * height };
  };
  const zoomAt = (factor, sx, sy) => {
    const g = geomRef.current;
    const nz = clamp(g.z * factor, 1, 20);
    const fx = clamp((sx - ml) / plotW, 0, 1), fy = clamp((sy - mt) / plotH, 0, 1);
    const dx = g.X0 + fx * (g.X1 - g.X0), dy = g.Y1 - fy * (g.Y1 - g.Y0);
    const nhw = (g.BX1 - g.BX0) / 2 / nz, nhh = (g.BY1 - g.BY0) / 2 / nz;
    setView({ z: nz, cx: dx - (fx - 0.5) * 2 * nhw, cy: dy + (fy - 0.5) * 2 * nhh });
  };
  const zoomBtn = f => zoomAt(f, ml + plotW / 2, mt + plotH / 2);
  const resetView = () => setView({ z: 1, cx: null, cy: null });

  // wheel zoom needs a non-passive listener to stop the page from scrolling
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const { sx, sy } = toSvg(e);
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, sx, sy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e) => {
    if (geomRef.current.z <= 1 || e.target.closest?.("circle")) return;
    svgRef.current.setPointerCapture?.(e.pointerId);
    const { sx, sy } = toSvg(e);
    dragRef.current = { sx, sy, cx, cy, w: X1 - X0, h: Y1 - Y0 };
  };
  const onPointerMove = (e) => {
    const d0 = dragRef.current;
    if (!d0) return;
    const { sx, sy } = toSvg(e);
    setView(v => ({ ...v, cx: d0.cx - ((sx - d0.sx) / plotW) * d0.w, cy: d0.cy + ((sy - d0.sy) / plotH) * d0.h }));
  };
  const onPointerUp = (e) => {
    dragRef.current = null;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
  };
  const px = x => ml + ((x - X0) / (X1 - X0)) * plotW;
  const py = y => mt + (1 - (y - Y0) / (Y1 - Y0)) * plotH;
  const path = poly => poly.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(2)},${py(p.y).toFixed(2)}`).join(" ");

  // per-point status for markers: vertical loss on the tread, nothing special on the flange
  const pointStatus = p => {
    if (p.x < r.boundaryX) return "ok";
    const sy = yAt(S, p.x);
    if (sy === null) return "ok";
    if (isPlain) return levelOf(Math.abs(sy - p.y), pl.wearWarn, pl.wearCrit) || "ok";
    return levelOf(Math.max(0, sy - p.y), r.treadWarn, r.treadCrit) || "ok";
  };

  const arrowHead = (x, y, dir) => {
    const s = 6;
    const pts = { up: [[x, y], [x - s / 2, y + s], [x + s / 2, y + s]], down: [[x, y], [x - s / 2, y - s], [x + s / 2, y - s]],
      left: [[x, y], [x + s, y - s / 2], [x + s, y + s / 2]], right: [[x, y], [x - s, y - s / 2], [x - s, y + s / 2]] }[dir];
    return <path d={`M${pts.map(q => q.join(",")).join(" L")} Z`} fill="#2563EB" />;
  };

  const tickX = niceTicks(X0, X1, 10), tickY = niceTicks(Y0, Y1, 7);
  const bx = px(r.boundaryX);

  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>
        {isPlain ? "โปรไฟล์หน้าล้อ เทียบกับมาตรฐาน" : "โปรไฟล์ล้อรถไฟ เทียบกับมาตรฐาน"}
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>
        แกน X / Y เป็น mm · เส้นประ = มาตรฐาน (ล้อใหม่) · เส้นทึบ = ที่วัดได้ · วัดแล้ว {M.length} จุด
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, marginTop: -30, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: z > 1 ? "#2563EB" : "#cbd5e1", minWidth: 36, textAlign: "right" }}>
          {Math.round(z * 100)}%
        </span>
        <button type="button" title="ซูมออก" disabled={z <= 1} onClick={() => zoomBtn(1 / 1.4)} style={{ ...zoomBtnStyle, opacity: z <= 1 ? 0.4 : 1 }}>−</button>
        <button type="button" title="ซูมเข้า" disabled={z >= 20} onClick={() => zoomBtn(1.4)} style={{ ...zoomBtnStyle, opacity: z >= 20 ? 0.4 : 1 }}>+</button>
        <button type="button" title="กลับสู่มุมมองเต็ม" disabled={z <= 1} onClick={resetView}
          style={{ ...zoomBtnStyle, width: "auto", padding: "0 8px", fontSize: 11,
            ...(z <= 1 ? { opacity: 0.4 } : { background: "#2563EB", color: "#fff", borderColor: "#2563EB" }) }}>รีเซ็ต</button>
        <div style={{ display: "inline-flex", padding: 3, gap: 3, background: "#f1f5f9", borderRadius: 8, border: "1px solid #e2e8f0" }}>
          {[[false, "สัดส่วนจริง"], [true, "ขยายความต่าง"]].map(([v, label]) => (
            <button key={label} type="button" onClick={() => setExaggerate(v)} style={{
              border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11.5, fontWeight: 700, fontFamily: "inherit",
              cursor: "pointer", background: exaggerate === v ? "#fff" : "transparent",
              color: exaggerate === v ? "#2563EB" : "#64748b",
              boxShadow: exaggerate === v ? "0 1px 2px rgba(15,23,42,0.12)" : "none",
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* headline numbers */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        {(isPlain
          ? [["สึกมากสุด", d.maxWear ? Math.max(0, d.maxWear.loss) : null, d.wearLevel],
             ["สึกเฉลี่ย", d.avgWear ?? null, null],
             ["นูนมากสุด", d.maxBulge ? d.maxBulge.bulge : 0, d.bulgeLevel]]
          : [["Tread Wear", d.treadWear, d.treadLevel], ["Flange Wear", d.flangeWear, d.flangeLevel]]
        ).map(([label, v, lv]) => {
          const c = lv === "critical" ? ["#991B1B", "#FEE2E2", "#FECACA"] : lv === "warning" ? ["#92400E", "#FEF3C7", "#FDE68A"]
            : lv === "ok" ? ["#166534", "#DCFCE7", "#BBF7D0"] : ["#64748b", "#f8fafc", "#e2e8f0"];
          return (
            <div key={label} style={{ background: c[1], border: `1px solid ${c[2]}`, borderRadius: 10, padding: "6px 12px", minWidth: 130 }}>
              <div style={{ fontSize: 11, color: c[0], fontWeight: 700 }}>{label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: c[0] }}>{v === null ? "—" : `${f2(v)} mm`}</div>
            </div>
          );
        })}
        {d.limits.map(l => (
          <div key={l.label} style={{
            background: !l.checked ? "#f8fafc" : l.exceeded ? "#FEE2E2" : "#DCFCE7",
            border: `1px solid ${!l.checked ? "#e2e8f0" : l.exceeded ? "#FECACA" : "#BBF7D0"}`,
            borderRadius: 10, padding: "6px 12px",
          }}>
            <div style={{ fontSize: 11, color: "#475569", fontWeight: 700 }}>{l.label}</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: !l.checked ? "#64748b" : l.exceeded ? "#991B1B" : "#166534" }}>
              {!l.checked ? "ยังวัดไม่ถึง" : l.exceeded ? "🔴 เกิน" : "✅ ไม่เกิน"}
            </div>
          </div>
        ))}
      </div>

      <svg ref={svgRef} width="100%" viewBox={`0 0 ${size} ${height}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
        style={{ display: "block", height: "auto", aspectRatio: `${size} / ${height}`, background: "#fcfdff", borderRadius: 8,
          cursor: z > 1 ? "grab" : "default", touchAction: z > 1 ? "none" : "pan-y", userSelect: "none" }}>
        <defs>
          <clipPath id={`${uid}-clip`}><rect x={ml} y={mt} width={plotW} height={plotH} /></clipPath>
        </defs>

        {/* grid */}
        {tickX.map(v => (
          <g key={`tx${v}`}>
            <line x1={px(v)} x2={px(v)} y1={mt} y2={mt + plotH} stroke="#eef2f7" />
            <text x={px(v)} y={mt + plotH + 18} fontSize="11" fill="#64748b" textAnchor="middle">{v}</text>
          </g>
        ))}
        {tickY.map(v => (
          <g key={`ty${v}`}>
            <line x1={ml} x2={ml + plotW} y1={py(v)} y2={py(v)} stroke={v === 0 ? "#cbd5e1" : "#eef2f7"} />
            <text x={ml - 8} y={py(v) + 4} fontSize="11" fill="#64748b" textAnchor="end">{v}</text>
          </g>
        ))}
        <rect x={ml} y={mt} width={plotW} height={plotH} fill="none" stroke="#94a3b8" />
        <text x={ml + plotW} y={height - 10} fontSize="12" fill="#334155" textAnchor="end" fontWeight="700">x, mm</text>
        <text x={14} y={mt + plotH / 2} fontSize="12" fill="#334155" textAnchor="middle" fontWeight="700"
          transform={`rotate(-90 14 ${mt + plotH / 2})`}>y, mm</text>

        {/* flange / tread boundary */}
        {!isPlain && bx >= ml && bx <= ml + plotW && (
          <g>
            <line x1={bx} x2={bx} y1={mt - 28} y2={mt + plotH} stroke="#2563EB" strokeDasharray="2 4" strokeWidth="1.4" />
            <text x={bx - 8} y={mt - 14} fontSize="12" fill="#334155" textAnchor="end" fontWeight="700">⇐ Flange</text>
            <text x={bx + 8} y={mt - 14} fontSize="12" fill="#334155" fontWeight="700">Tread ⇒</text>
          </g>
        )}

        <g clipPath={`url(#${uid}-clip)`}>
          {/* worn area on the tread (between standard and measured) */}
          {M.length >= 2 && S.length >= 2 && (() => {
            const a = Math.max(M[0].x, S[0].x), b = Math.min(M[M.length - 1].x, S[S.length - 1].x);
            if (b <= a) return null;
            const N = 160, top = [], bot = [];
            for (let k = 0; k <= N; k++) {
              const x = a + (k / N) * (b - a);
              const sy = yAt(S, x), my = yAt(M, x);
              if (sy === null || my === null) continue;
              top.push([px(x), py(sy)]);                 // only where measured is BELOW standard
              bot.push([px(x), py(Math.min(my, sy))]);
            }
            const dpath = `M${top.map(q => q.join(",")).join(" L")} L${bot.reverse().map(q => q.join(",")).join(" L")} Z`;
            return <path d={dpath} fill="#F87171" opacity="0.28" />;
          })()}

          {S.length >= 2 && <path d={path(S)} fill="none" stroke="#0f172a" strokeWidth="2" strokeDasharray="8 5" />}
          {M.length >= 2 && <path d={path(M)} fill="none" stroke="#2563EB" strokeWidth="2.4" strokeLinejoin="round" />}
          {M.map((p, i) => {
            const st = STATUS[pointStatus(p)];
            return (
              <circle key={i} cx={px(p.x)} cy={py(p.y)} r={hover === i ? 5.5 : 3.2}
                fill={st.fill} stroke={st.stroke} strokeWidth="1.2"
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(h => (h === i ? null : h))}
                style={{ cursor: "pointer" }}>
                <title>{`X ${p.x} mm · Y ${p.y} mm`}</title>
              </circle>
            );
          })}
        </g>

        <g clipPath={`url(#${uid}-clip)`}>
        {/* limit points */}
        {r.limits.map((l, i) => {
          const lim = d.limits[i];
          const color = lim?.exceeded ? "#DC2626" : i === 0 ? "#2563EB" : "#0f172a";
          const x = px(l.x), y = py(l.y);
          return (
            <g key={`lim${i}`}>
              <text x={x} y={y + 6} fontSize="18" fill={color} textAnchor="middle" fontWeight="700">✱</text>
              {(() => {
                // label below-left of the point, kept inside the plot
                const ly = Math.min(mt + plotH - 8 - (r.limits.length - 1 - i) * 16, y + 40 + i * 30);
                const lx = Math.max(ml + 6, x - 70);
                return (
                  <g>
                    <line x1={x - 2} y1={y + 9} x2={lx + 40} y2={ly - 11} stroke={color} strokeWidth="1" />
                    <text x={lx} y={ly} fontSize="10.5" fill={color} stroke="#fcfdff" strokeWidth="3" paintOrder="stroke">
                      {l.label} ({l.x}, {l.y})
                    </text>
                  </g>
                );
              })()}
            </g>
          );
        })}

        {/* Flange Wear: horizontal gap at height flangeY */}
        {d.std?.flangeX != null && (() => {
          const y = py(r.flangeY), xs1 = px(d.std.flangeX);
          const xm = d.meas?.flangeX != null ? px(d.meas.flangeX) : null;
          return (
            <g>
              <text x={xs1} y={y + 5} fontSize="14" fill="#0f172a" textAnchor="middle">+</text>
              {xm !== null && <text x={xm} y={y + 4} fontSize="13" fill="#2563EB" textAnchor="middle">×</text>}
              {xm !== null && (
                <g>
                  <line x1={Math.min(xm, xs1) - 22} x2={Math.min(xm, xs1)} y1={y - 22} y2={y - 22} stroke="#2563EB" />
                  {arrowHead(Math.min(xm, xs1), y - 22, "right")}
                  <line x1={Math.max(xm, xs1)} x2={Math.max(xm, xs1) + 22} y1={y - 22} y2={y - 22} stroke="#2563EB" />
                  {arrowHead(Math.max(xm, xs1), y - 22, "left")}
                  <line x1={xm} x2={xm} y1={y - 34} y2={y + 4} stroke="#2563EB" strokeWidth="0.8" />
                  <line x1={xs1} x2={xs1} y1={y - 34} y2={y + 4} stroke="#2563EB" strokeWidth="0.8" />
                  <text x={Math.max(xm, xs1) + 28} y={y - 18} fontSize="12" fill="#0f172a" fontWeight="700">
                    Flange Wear {f2(d.flangeWear)} mm
                  </text>
                </g>
              )}
            </g>
          );
        })()}

        {/* Tread Wear: vertical gap at treadX */}
        {d.std?.treadY != null && (() => {
          const x = px(r.treadX), ys1 = py(d.std.treadY);
          const ym = d.meas?.treadY != null ? py(d.meas.treadY) : null;
          return (
            <g>
              <text x={x} y={ys1 + 5} fontSize="14" fill="#0f172a" textAnchor="middle">+</text>
              {ym !== null && (
                <g>
                  <text x={x} y={ym + 4} fontSize="13" fill="#2563EB" textAnchor="middle">×</text>
                  <line x1={x - 30} x2={x + 30} y1={ys1} y2={ys1} stroke="#2563EB" strokeWidth="0.8" />
                  <line x1={x - 30} x2={x + 30} y1={ym} y2={ym} stroke="#2563EB" strokeWidth="0.8" />
                  <line x1={x} x2={x} y1={Math.min(ys1, ym) - 22} y2={Math.min(ys1, ym)} stroke="#2563EB" />
                  {arrowHead(x, Math.min(ys1, ym), "down")}
                  <line x1={x} x2={x} y1={Math.max(ys1, ym)} y2={Math.max(ys1, ym) + 22} stroke="#2563EB" />
                  {arrowHead(x, Math.max(ys1, ym), "up")}
                  <text x={x + 8} y={Math.min(ys1, ym) - 28} fontSize="12" fill="#0f172a" fontWeight="700" textAnchor="middle">
                    Tread Wear {f2(d.treadWear)} mm
                  </text>
                </g>
              )}
            </g>
          );
        })()}

        {/* Plain wheel: arrow at the point of maximum wear */}
        {isPlain && d.maxWear && d.maxWear.loss > 0.005 && (() => {
          const x = px(d.maxWear.x), sy = yAt(S, d.maxWear.x);
          if (sy === null) return null;
          const ys1 = py(sy), ym = py(sy - d.maxWear.loss);
          return (
            <g>
              <text x={x} y={ys1 + 5} fontSize="14" fill="#0f172a" textAnchor="middle">+</text>
              <text x={x} y={ym + 4} fontSize="13" fill="#2563EB" textAnchor="middle">×</text>
              <line x1={x - 30} x2={x + 30} y1={ys1} y2={ys1} stroke="#2563EB" strokeWidth="0.8" />
              <line x1={x - 30} x2={x + 30} y1={ym} y2={ym} stroke="#2563EB" strokeWidth="0.8" />
              <line x1={x} x2={x} y1={ys1 - 22} y2={ys1} stroke="#2563EB" />
              {arrowHead(x, ys1, "down")}
              <line x1={x} x2={x} y1={ym} y2={ym + 22} stroke="#2563EB" />
              {arrowHead(x, ym, "up")}
              {(() => {
                // label beside the arrow (right side, or left near the right edge), inside the plot
                const right = x < ml + plotW - 150;
                const ly = Math.min(Math.max((ys1 + ym) / 2 + 4, mt + 14), mt + plotH - 6);
                return (
                  <text x={right ? x + 12 : x - 12} y={ly} fontSize="12" fill="#0f172a" fontWeight="700"
                    textAnchor={right ? "start" : "end"} stroke="#fcfdff" strokeWidth="3" paintOrder="stroke">
                    สึกมากสุด {f2(d.maxWear.loss)} mm
                  </text>
                );
              })()}
            </g>
          );
        })()}

        </g>
        {/* hover readout */}
        {hover !== null && M[hover] && (
          <text x={px(M[hover].x)} y={py(M[hover].y) - 10} fontSize="11" fontWeight="700" fill="#1E3A8A"
            textAnchor="middle" stroke="#fff" strokeWidth="3" paintOrder="stroke">
            X {M[hover].x} · Y {M[hover].y}
          </text>
        )}
      </svg>

      {/* diagnosis */}
      {d.level && (() => {
        const tone = { critical: ["#FEF2F2", "#FECACA", "#991B1B"], warning: ["#FFFBEB", "#FDE68A", "#92400E"], ok: ["#F0FDF4", "#BBF7D0", "#166534"] }[d.level];
        const dot = { ok: "#16A34A", warn: "#D97706", bad: "#DC2626", info: "#64748B" };
        return (
          <div style={{ marginTop: 12, background: tone[0], border: `1px solid ${tone[1]}`, borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#334155", marginBottom: 4 }}>📋 สรุปอาการจากกราฟ</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: tone[2], marginBottom: 6 }}>{d.verdict}</div>
            {d.findings.map((f, i) => (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: "#334155", lineHeight: 1.5 }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: dot[f.tone], marginTop: 6, flexShrink: 0 }} />
                <span>{f.text}</span>
              </div>
            ))}
          </div>
        );
      })()}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 11.5, color: "#475569", marginTop: 10 }}>
        <span><span style={{ display: "inline-block", width: 22, borderTop: "2px dashed #0f172a", verticalAlign: "middle", marginRight: 6 }} />มาตรฐาน (ล้อใหม่)</span>
        <span><span style={{ display: "inline-block", width: 22, borderTop: "2.4px solid #2563EB", verticalAlign: "middle", marginRight: 6 }} />ที่วัดได้</span>
        <span><span style={{ display: "inline-block", width: 12, height: 10, background: "#F87171", opacity: 0.4, verticalAlign: "middle", marginRight: 6 }} />ส่วนที่สึก</span>
        <span>+ / × = จุดอ้างอิงที่ใช้วัด (มาตรฐาน / ที่วัดได้)</span>
        {!isPlain && <span>✱ = จุดขีดจำกัด</span>}
      </div>
    </div>
  );
}
