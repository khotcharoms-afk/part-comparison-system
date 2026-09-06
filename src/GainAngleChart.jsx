import { useRef, useState, useEffect } from "react";

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

function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const step = (max - min) / count;
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(min + step * i);
  return ticks;
}

// Builds a smooth SVG path ("d" attribute) through a series of points using
// monotone cubic (Fritsch–Carlson) interpolation, so the measured-value line
// curves gently between points instead of connecting them with sharp straight
// segments — WITHOUT overshooting past the data's local highs/lows.
//
// Note: a plain Catmull-Rom spline (the earlier approach here) computes each
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
 * X axis = point number (#1..#N, position measured around the wheel)
 * Y axis = the raw Gain Y value entered at that point
 * A flat purple reference line marks the standard's average Gain Y so every point's
 * deviation from spec is visible at a glance, with a thin orange line marking the
 * average of what was actually measured.
 */
export default function GainAngleChart({ standardX, standardY, points, avgX, avgY, count }) {
  const [zoom, setZoom] = useState(1);
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

  const diff = (hasStandardY && hasAvgY) ? (avgY - sy) : null;
  const diffPercent = (diff !== null && sy !== 0) ? (Math.abs(diff) / Math.abs(sy)) * 100 : null;
  const diffX = (hasStandardX && hasAvgX) ? (avgX - sx) : null;
  const diffXPercent = (diffX !== null && sx !== 0) ? (Math.abs(diffX) / Math.abs(sx)) * 100 : null;

  // Base (zoom = 1) data bounds. X = point index; Y = raw Gain Y value.
  const rawMinXIdx = 1, rawMaxXIdx = Math.max(totalPoints, 2);
  const allY = [
    ...(hasStandardY ? [sy] : []),
    ...(hasAvgY ? [avgY] : []),
    ...validSeries.map(p => p.yVal),
  ];
  const rawMinY = allY.length ? Math.min(...allY) : -1;
  const rawMaxY = allY.length ? Math.max(...allY) : 1;
  const rangeY = (rawMaxY - rawMinY) || 1;
  const baseMinX = rawMinXIdx - 0.6, baseMaxX = rawMaxXIdx + 0.6;
  const baseMinY = rawMinY - rangeY * 0.25, baseMaxY = rawMaxY + rangeY * 0.25;
  const baseCenterX = (baseMinX + baseMaxX) / 2, baseCenterY = (baseMinY + baseMaxY) / 2;
  const baseHalfW = (baseMaxX - baseMinX) / 2, baseHalfH = (baseMaxY - baseMinY) / 2;

  const centerX = baseCenterX, centerY = baseCenterY;
  const halfW = baseHalfW / zoom, halfH = baseHalfH / zoom;
  const minX = centerX - halfW, maxX = centerX + halfW;
  const minY = centerY - halfH, maxY = centerY + halfH;

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

  const yTicks = niceTicks(minY, maxY);

  const clampZoom = z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const zoomIn = () => setZoom(z => clampZoom(z * 1.5));
  const zoomOut = () => setZoom(z => clampZoom(z / 1.5));
  const resetView = () => { setZoom(1); };

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

  const stdPy = hasStandardY ? toPx(0, sy).py : null;
  const avgPy = hasAvgY ? toPx(0, avgY).py : null;

  const linePoints = validSeries.map(p => toPx(p.idx, p.yVal));
  const smoothPathStr = smoothPathFromPoints(linePoints);

  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>
            Gain Y แต่ละจุดวัด เทียบกับค่ามาตรฐาน
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>เฉลี่ยจากข้อมูล {count || 0}/{totalPoints} จุดที่กรอก</div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={zoomOut} title="ซูมออก" style={zoomBtnStyle}>−</button>
          <button onClick={zoomIn} title="ซูมเข้า" style={zoomBtnStyle}>+</button>
          <button onClick={resetView} title="รีเซ็ตมุมมอง" style={{ ...zoomBtnStyle, width: "auto", padding: "0 8px", fontSize: 10 }}>
            รีเซ็ต
          </button>
        </div>
      </div>

      <svg
        ref={svgRef}
        width="100%" height={height} viewBox={`0 0 ${size} ${height}`}
        style={{ background: "#fcfdff", borderRadius: 8, display: "block" }}
      >
        <defs>
          <clipPath id="gac-clip">
            <rect x={margin} y={margin} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* Y grid lines — kept unlabeled to avoid clutter */}
        {yTicks.map((t, i) => {
          const { py } = toPx(0, t);
          return (
            <line key={`gy-${i}`} x1={margin} y1={py} x2={size - margin} y2={py} stroke="#f1f5f9" strokeWidth="1" />
          );
        })}

        {/* 0 reference line — the one fixed anchor so up/down orientation is never ambiguous,
            especially when most values are negative */}
        {minY <= 0 && 0 <= maxY && (() => {
          const { py } = toPx(0, 0);
          return (
            <g>
              <line x1={margin} y1={py} x2={size - margin} y2={py} stroke="#cbd5e1" strokeWidth="1.3" />
              <text x={margin - 4} y={py + 3} fontSize="10" fill="#94a3b8" textAnchor="end">0</text>
            </g>
          );
        })()}

        {/* top/bottom range labels — minimal orientation without a full numbered axis */}
        <text x={margin - 4} y={margin + 3} fontSize="10" fill="#cbd5e1" textAnchor="end">
          {maxY.toFixed(2)}
        </text>
        <text x={margin - 4} y={height - margin + 1} fontSize="10" fill="#cbd5e1" textAnchor="end">
          {minY.toFixed(2)}
        </text>

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
          {/* standard reference line — flat, spans full width */}
          {stdPy !== null && (
            <>
              <line x1={margin} y1={stdPy} x2={size - margin} y2={stdPy}
                stroke="#64748B" strokeWidth="2" strokeDasharray="7 4" />
              <text x={size - margin - 4} y={stdPy - 6} fontSize="10.5" fill="#475569" textAnchor="end" fontWeight="700">
                มาตรฐาน {sy.toFixed(2)}
              </text>
            </>
          )}
          {/* average measured line — flat, spans full width */}
          {avgPy !== null && (
            <>
              <line x1={margin} y1={avgPy} x2={size - margin} y2={avgPy}
                stroke="#D97706" strokeWidth="1.5" strokeDasharray="2 3" />
              <text x={margin + 4} y={avgPy - 6} fontSize="10.5" fill="#92400E" textAnchor="start" fontWeight="700">
                เฉลี่ยที่วัดได้ {avgY.toFixed(2)}
              </text>
            </>
          )}

          {/* deviation connector from each point down/up to the standard line */}
          {stdPy !== null && linePoints.map((pt, i) => (
            <line key={`dev-${i}`} x1={pt.px} y1={pt.py} x2={pt.px} y2={stdPy}
              stroke="#BFDBFE" strokeWidth="1" strokeDasharray="2 2" opacity="0.8" />
          ))}

          {/* smooth curve through the raw entered points, in order — reads like a
              wheel's profile curve instead of sharp straight segments */}
          {linePoints.length > 1 && (
            <path d={smoothPathStr} fill="none" stroke="#2563EB" strokeWidth="2.4"
              strokeLinejoin="round" strokeLinecap="round" />
          )}

          {/* each measured point, with Gain Y + Gain X + deviation-from-standard, and tooltip */}
          {validSeries.map((p) => {
            const { px, py } = toPx(p.idx, p.yVal);
            const devVal = hasStandardY ? p.yVal - sy : null;
            const devPct = (devVal !== null && sy !== 0) ? (Math.abs(devVal) / Math.abs(sy)) * 100 : null;
            return (
              <g key={p.idx}>
                <circle cx={px} cy={py} r="5.5" fill="#93C5FD" stroke="#2563EB" strokeWidth="1.2">
                  <title>{`จุดที่ ${p.idx}: X=${p.x}, Y=${p.y}`}</title>
                </circle>
                <text x={px} y={py - 18} fontSize="10" fill="#1E3A8A" textAnchor="middle" fontWeight="700">
                  Y={p.yVal}{devPct !== null ? ` (Δ${devPct.toFixed(0)}%)` : ""}
                </text>
                <text x={px} y={py - 8} fontSize="8.5" fill="#2563EB" textAnchor="middle">
                  X={p.x}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div style={{ fontSize: 12, color: "#475569", marginTop: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 8 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#334155" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#64748B", flexShrink: 0 }} />
              มาตรฐาน
            </div>
            <div style={{ marginLeft: 16 }}>
              Gain X: {hasStandardX ? sx : "—"} &nbsp; Gain Y: {hasStandardY ? sy : "—"}
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
          scroll/ปุ่ม +− เพื่อซูม · เส้นประบางๆ ที่จุด = ระยะห่างจากค่ามาตรฐาน
        </div>
      </div>
    </div>
  );
}

const zoomBtnStyle = {
  width: 22, height: 22, border: "1px solid #e2e8f0", borderRadius: 6,
  background: "#f8fafc", color: "#475569", fontSize: 13, fontWeight: 700,
  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
  padding: 0, fontFamily: "inherit",
};
