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

// Angle is derived from atan2(y, x) in degrees, standard math convention
// (0° = +X axis, counter-clockwise positive).
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
    d = ((d + 180) % 360 + 360) % 360 - 180; // normalize to -180..180
    angleDiff = d;
    angleDiffPercent = angleStandard !== 0 ? (Math.abs(d) / Math.abs(angleStandard)) * 100 : null;
  }

  return { angleStandard, angleMeasured, angleDiff, angleDiffPercent };
}

function angleOf(x, y) {
  const px = parseFloat(x), py = parseFloat(y);
  if (isNaN(px) || isNaN(py)) return null;
  return Math.atan2(py, px) * (180 / Math.PI);
}

function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const step = (max - min) / count;
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(min + step * i);
  return ticks;
}

const ZOOM_MIN = 1, ZOOM_MAX = 20;

/**
 * Horizontal "run chart" — like a tire wear-profile readout:
 * X axis = point number (#1..#N, position measured around the wheel)
 * Y axis = angle (°) derived from that point's Gain X/Y
 * A flat purple reference line marks the standard angle so every point's
 * deviation from spec is visible at a glance, with a thin orange line marking
 * the average of what was actually measured.
 */
export default function GainAngleChart({ standardX, standardY, points, avgX, avgY, count }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const svgRef = useRef(null);

  const { angleStandard, angleMeasured, angleDiff, angleDiffPercent } =
    computeAngleInfo(standardX, standardY, avgX, avgY);

  const sx = parseFloat(standardX), sy = parseFloat(standardY);
  const hasStandardValue = !isNaN(sx) && !isNaN(sy);
  const hasAvgValue = avgX !== null && avgY !== null && !isNaN(avgX) && !isNaN(avgY);
  // Whether the angle itself is defined — false for (0,0), even if the raw x/y are valid numbers,
  // since atan2(0,0) has no meaningful direction. This must gate every use of angleStandard/
  // angleMeasured; using a looser NaN-only check here caused angleStandard to be null while the
  // line was still drawn, crashing on angleStandard.toFixed(...).
  const hasStandard = angleStandard !== null;
  const hasAvg = angleMeasured !== null;

  const totalPoints = points?.length || 0;
  const series = (points || []).map((p, i) => ({ idx: i + 1, x: p.x, y: p.y, angle: angleOf(p.x, p.y) }));
  const validSeries = series.filter(p => p.angle !== null);

  // Base (zoom = 1) data bounds. X = point index; Y = angle (deg).
  const rawMinXIdx = 1, rawMaxXIdx = Math.max(totalPoints, 2);
  const allY = [
    ...(hasStandard ? [angleStandard] : []),
    ...(hasAvg ? [angleMeasured] : []),
    ...validSeries.map(p => p.angle),
  ];
  const rawMinY = allY.length ? Math.min(...allY) : -10;
  const rawMaxY = allY.length ? Math.max(...allY) : 10;
  const rangeY = (rawMaxY - rawMinY) || 10;
  const baseMinX = rawMinXIdx - 0.6, baseMaxX = rawMaxXIdx + 0.6;
  const baseMinY = rawMinY - rangeY * 0.25, baseMaxY = rawMaxY + rangeY * 0.25;
  const baseCenterX = (baseMinX + baseMaxX) / 2, baseCenterY = (baseMinY + baseMaxY) / 2;
  const baseHalfW = (baseMaxX - baseMinX) / 2, baseHalfH = (baseMaxY - baseMinY) / 2;

  const centerX = baseCenterX + pan.x, centerY = baseCenterY + pan.y;
  const halfW = baseHalfW / zoom, halfH = baseHalfH / zoom;
  const minX = centerX - halfW, maxX = centerX + halfW;
  const minY = centerY - halfH, maxY = centerY + halfH;

  const size = 520, height = 300, margin = 50;
  const plotW = size - margin * 2, plotH = height - margin * 2;

  const toPx = (x, y) => ({
    px: margin + ((x - minX) / (maxX - minX)) * plotW,
    py: margin + (1 - (y - minY) / (maxY - minY)) * plotH,
  });

  const yTicks = niceTicks(minY, maxY);

  const clampZoom = z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const zoomIn = () => setZoom(z => clampZoom(z * 1.5));
  const zoomOut = () => setZoom(z => clampZoom(z / 1.5));
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

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
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = { startClientX: e.clientX, startClientY: e.clientY, startPan: pan, pxPerUnitX, pxPerUnitY };
  };
  const handlePointerMove = (e) => {
    if (!dragRef.current) return;
    const { startClientX, startClientY, startPan, pxPerUnitX: ppuX, pxPerUnitY: ppuY } = dragRef.current;
    const dPx = e.clientX - startClientX, dPy = e.clientY - startClientY;
    setPan({ x: startPan.x - dPx / ppuX, y: startPan.y + dPy / ppuY });
  };
  const handlePointerUp = (e) => {
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  const stdPy = hasStandard ? toPx(0, angleStandard).py : null;
  const avgPy = hasAvg ? toPx(0, angleMeasured).py : null;

  const linePoints = validSeries.map(p => toPx(p.idx, p.angle));
  const polylineStr = linePoints.map(pt => `${pt.px},${pt.py}`).join(" ");

  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>
            มุมแต่ละจุดวัด เทียบกับค่ามาตรฐาน
          </div>
          <div style={{ fontSize: 10, color: "#94a3b8" }}>เฉลี่ยจากข้อมูล {count || 0}/{totalPoints} จุดที่กรอก</div>
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
        style={{ touchAction: "none", cursor: "grab", background: "#fcfdff", borderRadius: 8, display: "block" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <defs>
          <clipPath id="gac-clip">
            <rect x={margin} y={margin} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* Y grid lines (angle reference) — no numeric axis labels; exact values are shown on each point */}
        {yTicks.map((t, i) => {
          const { py } = toPx(0, t);
          return (
            <line key={`gy-${i}`} x1={margin} y1={py} x2={size - margin} y2={py} stroke="#f1f5f9" strokeWidth="1" />
          );
        })}

        {/* X axis labels — point index */}
        {series.map((p) => {
          const { px } = toPx(p.idx, minY);
          if (px < margin - 1 || px > size - margin + 1) return null;
          return (
            <text key={`xt-${p.idx}`} x={px} y={height - margin + 16} fontSize="9" fill="#94a3b8" textAnchor="middle">
              #{p.idx}
            </text>
          );
        })}

        <g clipPath="url(#gac-clip)">
          {/* standard reference line — flat, spans full width */}
          {stdPy !== null && (
            <>
              <line x1={margin} y1={stdPy} x2={size - margin} y2={stdPy}
                stroke="#6B21A8" strokeWidth="2" strokeDasharray="7 4" />
              <text x={size - margin - 4} y={stdPy - 5} fontSize="9" fill="#6B21A8" textAnchor="end" fontWeight="700">
                มาตรฐาน {angleStandard.toFixed(1)}°
              </text>
            </>
          )}
          {/* average measured line — flat, spans full width */}
          {avgPy !== null && (
            <>
              <line x1={margin} y1={avgPy} x2={size - margin} y2={avgPy}
                stroke="#F97316" strokeWidth="1.5" strokeDasharray="2 3" />
              <text x={margin + 4} y={avgPy - 5} fontSize="9" fill="#c2410c" textAnchor="start" fontWeight="700">
                เฉลี่ยที่วัดได้ {angleMeasured.toFixed(1)}°
              </text>
            </>
          )}

          {/* deviation connector from each point down/up to the standard line */}
          {stdPy !== null && linePoints.map((pt, i) => (
            <line key={`dev-${i}`} x1={pt.px} y1={pt.py} x2={pt.px} y2={stdPy}
              stroke="#FDBA74" strokeWidth="1" strokeDasharray="2 2" opacity="0.7" />
          ))}

          {/* line connecting the raw entered points in order */}
          {linePoints.length > 1 && (
            <polyline points={polylineStr} fill="none" stroke="#FB923C" strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round" />
          )}

          {/* each measured point, with angle + raw Gain X/Y + deviation-from-standard, and tooltip */}
          {validSeries.map((p) => {
            const { px, py } = toPx(p.idx, p.angle);
            const devPct = angleStandard != null && angleStandard !== 0
              ? (Math.abs(p.angle - angleStandard) / Math.abs(angleStandard)) * 100
              : null;
            return (
              <g key={p.idx}>
                <circle cx={px} cy={py} r="4.5" fill="#FDBA74" stroke="#F97316" strokeWidth="1">
                  <title>{`จุดที่ ${p.idx}: X=${p.x}, Y=${p.y} → มุม ${p.angle.toFixed(1)}°`}</title>
                </circle>
                <text x={px} y={py - 16} fontSize="8.5" fill="#c2410c" textAnchor="middle" fontWeight="700">
                  {p.angle.toFixed(1)}°{devPct !== null ? ` (Δ${devPct.toFixed(0)}%)` : ""}
                </text>
                <text x={px} y={py - 7} fontSize="7.5" fill="#c2820c" textAnchor="middle">
                  X={p.x}, Y={p.y}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div style={{ fontSize: 12, color: "#475569", marginTop: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 8 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#4c1d95" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#6B21A8", flexShrink: 0 }} />
              มาตรฐาน
            </div>
            <div style={{ marginLeft: 16 }}>
              Gain X: {hasStandardValue ? sx : "—"} &nbsp; Gain Y: {hasStandardValue ? sy : "—"}
            </div>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#c2410c" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#F97316", flexShrink: 0 }} />
              ค่าเฉลี่ยที่วัดได้
            </div>
            <div style={{ marginLeft: 16 }}>
              Gain X: {hasAvgValue ? avgX.toFixed(3) : "—"} &nbsp; Gain Y: {hasAvgValue ? avgY.toFixed(3) : "—"}
            </div>
          </div>
        </div>

        {angleDiff !== null ? (
          <div style={{
            padding: "8px 10px", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0",
            fontWeight: 700, color: "#0f172a", fontSize: 13, display: "inline-block",
          }}>
            เปลี่ยนไป {Math.abs(angleDiff).toFixed(1)}°
            {angleDiffPercent !== null && ` (${angleDiffPercent.toFixed(1)}%)`}
          </div>
        ) : (
          <div style={{ color: "#94a3b8", fontSize: 11 }}>
            กรอกค่ามาตรฐานและค่าที่วัดอย่างน้อย 1 จุดเพื่อคำนวณ
          </div>
        )}
        <div style={{ fontSize: 9.5, color: "#cbd5e1", marginTop: 8 }}>
          ลากเพื่อเลื่อนมุมมอง · scroll/ปุ่ม +− เพื่อซูม · เส้นประบางๆ ที่จุด = ระยะห่างจากค่ามาตรฐาน
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
