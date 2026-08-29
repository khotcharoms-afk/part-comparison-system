import { useRef, useState, useEffect } from "react";

/**
 * Shared calculations (also used from PartPage.jsx when saving to Firestore).
 */

// Averages up to 10 (x,y) measurement points, ignoring incomplete/invalid rows.
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

function niceTicks(min, max, count = 6) {
  if (min === max) { min -= 1; max += 1; }
  const step = (max - min) / count;
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(min + step * i);
  return ticks;
}

function decimalsForRange(range) {
  if (range <= 0.02) return 4;
  if (range <= 0.2) return 3;
  if (range <= 2) return 2;
  return 1;
}

const ZOOM_MIN = 1, ZOOM_MAX = 20;

/**
 * Cartesian-style (proper axes + grid) plot of:
 * - up to 10 raw measured points (small orange dots, hover for exact value)
 * - the averaged measured point / vector (solid orange)
 * - the standard point / vector (dashed purple)
 * Supports zoom (buttons, scroll wheel) and drag-to-pan for inspecting close values.
 */
export default function GainAngleChart({ standardX, standardY, points, avgX, avgY, count }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null); // { startPx, startPy, startPan, pxPerUnitX, pxPerUnitY }
  const svgRef = useRef(null);

  const { angleStandard, angleMeasured, angleDiff, angleDiffPercent } =
    computeAngleInfo(standardX, standardY, avgX, avgY);

  const sx = parseFloat(standardX), sy = parseFloat(standardY);
  const hasStandard = !isNaN(sx) && !isNaN(sy);
  const validPoints = (points || [])
    .map((p, i) => ({ x: parseFloat(p.x), y: parseFloat(p.y), idx: i + 1 }))
    .filter(p => !isNaN(p.x) && !isNaN(p.y));
  const hasAvg = avgX !== null && avgY !== null && !isNaN(avgX) && !isNaN(avgY);

  // Base (zoom = 1) data bounds — always include the origin so axes stay visible.
  const allX = [0, ...(hasStandard ? [sx] : []), ...(hasAvg ? [avgX] : []), ...validPoints.map(p => p.x)];
  const allY = [0, ...(hasStandard ? [sy] : []), ...(hasAvg ? [avgY] : []), ...validPoints.map(p => p.y)];
  const rawMinX = Math.min(...allX), rawMaxX = Math.max(...allX);
  const rawMinY = Math.min(...allY), rawMaxY = Math.max(...allY);
  const rangeX = (rawMaxX - rawMinX) || 1;
  const rangeY = (rawMaxY - rawMinY) || 1;
  const baseMinX = rawMinX - rangeX * 0.25, baseMaxX = rawMaxX + rangeX * 0.25;
  const baseMinY = rawMinY - rangeY * 0.25, baseMaxY = rawMaxY + rangeY * 0.25;
  const baseCenterX = (baseMinX + baseMaxX) / 2, baseCenterY = (baseMinY + baseMaxY) / 2;
  const baseHalfW = (baseMaxX - baseMinX) / 2, baseHalfH = (baseMaxY - baseMinY) / 2;

  // Apply zoom + pan on top of the base view.
  const centerX = baseCenterX + pan.x, centerY = baseCenterY + pan.y;
  const halfW = baseHalfW / zoom, halfH = baseHalfH / zoom;
  const minX = centerX - halfW, maxX = centerX + halfW;
  const minY = centerY - halfH, maxY = centerY + halfH;

  const size = 280, margin = 36;
  const plotW = size - margin * 2, plotH = size - margin * 2;

  const toPx = (x, y) => ({
    px: margin + ((x - minX) / (maxX - minX)) * plotW,
    py: margin + (1 - (y - minY) / (maxY - minY)) * plotH,
  });

  const origin = toPx(0, 0);
  const stdPx = hasStandard ? toPx(sx, sy) : null;
  const avgPx = hasAvg ? toPx(avgX, avgY) : null;
  const xTicks = niceTicks(minX, maxX);
  const yTicks = niceTicks(minY, maxY);
  const decimals = decimalsForRange(Math.min(maxX - minX, maxY - minY));

  const clampZoom = z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const zoomIn = () => setZoom(z => clampZoom(z * 1.5));
  const zoomOut = () => setZoom(z => clampZoom(z / 1.5));
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // React's onWheel is attached as a passive listener, so preventDefault() inside it
  // is silently ignored and the page scrolls instead of the chart zooming. Attaching
  // a native listener with { passive: false } lets us actually stop page scroll here.
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
    dragRef.current = {
      startClientX: e.clientX, startClientY: e.clientY,
      startPan: pan, pxPerUnitX, pxPerUnitY,
    };
  };
  const handlePointerMove = (e) => {
    if (!dragRef.current) return;
    const { startClientX, startClientY, startPan, pxPerUnitX: ppuX, pxPerUnitY: ppuY } = dragRef.current;
    const dPx = e.clientX - startClientX;
    const dPy = e.clientY - startClientY;
    // dragging right/down should reveal content in that direction (pan the view opposite way)
    setPan({
      x: startPan.x - dPx / ppuX,
      y: startPan.y + dPy / ppuY, // + because screen y is flipped vs data y
    });
  };
  const handlePointerUp = (e) => {
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>มุมจาก Gain X / Gain Y</div>
          <div style={{ fontSize: 10, color: "#94a3b8" }}>เฉลี่ยจากข้อมูล {count || 0}/10 จุดที่กรอก</div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={zoomOut} title="ซูมออก" style={zoomBtnStyle}>−</button>
          <button onClick={zoomIn} title="ซูมเข้า" style={zoomBtnStyle}>+</button>
          <button onClick={resetView} title="รีเซ็ตมุมมอง" style={{ ...zoomBtnStyle, width: "auto", padding: "0 8px", fontSize: 10 }}>
            รีเซ็ต
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <svg
          ref={svgRef}
          width={size} height={size} viewBox={`0 0 ${size} ${size}`}
          style={{ flexShrink: 0, touchAction: "none", cursor: "grab", background: "#fcfdff", borderRadius: 8 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <defs>
            <marker id="gac-arrow-purple" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#6B21A8" />
            </marker>
            <marker id="gac-arrow-orange" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#F97316" />
            </marker>
            <clipPath id="gac-clip">
              <rect x={margin} y={margin} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {/* grid lines + tick labels */}
          {xTicks.map((t, i) => {
            const { px } = toPx(t, 0);
            return (
              <g key={`gx-${i}`}>
                <line x1={px} y1={margin} x2={px} y2={size - margin} stroke="#f1f5f9" strokeWidth="1" />
                <text x={px} y={size - margin + 12} fontSize="7" fill="#94a3b8" textAnchor="middle">
                  {t.toFixed(decimals)}
                </text>
              </g>
            );
          })}
          {yTicks.map((t, i) => {
            const { py } = toPx(0, t);
            return (
              <g key={`gy-${i}`}>
                <line x1={margin} y1={py} x2={size - margin} y2={py} stroke="#f1f5f9" strokeWidth="1" />
                <text x={margin - 4} y={py + 2} fontSize="7" fill="#94a3b8" textAnchor="end">
                  {t.toFixed(decimals)}
                </text>
              </g>
            );
          })}

          <g clipPath="url(#gac-clip)">
            {/* axes through origin */}
            <line x1={margin} y1={origin.py} x2={size - margin} y2={origin.py} stroke="#cbd5e1" strokeWidth="1.2" />
            <line x1={origin.px} y1={margin} x2={origin.px} y2={size - margin} stroke="#cbd5e1" strokeWidth="1.2" />

            {/* line connecting the raw entered points in order — shows the actual measured trend,
                distinct from the single standard vector and the average vector below */}
            {validPoints.length > 1 && (
              <polyline
                points={validPoints.map(p => { const { px, py } = toPx(p.x, p.y); return `${px},${py}`; }).join(" ")}
                fill="none" stroke="#FB923C" strokeWidth="1.6" strokeOpacity="0.6"
                strokeDasharray="3 2.5" strokeLinejoin="round" strokeLinecap="round"
              />
            )}

            {/* raw measured points, with index label + native tooltip for exact value */}
            {validPoints.map((p) => {
              const { px, py } = toPx(p.x, p.y);
              return (
                <g key={p.idx}>
                  <circle cx={px} cy={py} r="3" fill="#FDBA74" stroke="#F97316" strokeWidth="0.75">
                    <title>{`จุดที่ ${p.idx}: X=${p.x}, Y=${p.y}`}</title>
                  </circle>
                  <text x={px + 4} y={py - 4} fontSize="6.5" fill="#c2410c">{p.idx}</text>
                </g>
              );
            })}

            {/* standard vector */}
            {stdPx && (
              <line x1={origin.px} y1={origin.py} x2={stdPx.px} y2={stdPx.py}
                stroke="#6B21A8" strokeWidth="2.4" strokeDasharray="6 3" strokeLinecap="round"
                markerEnd="url(#gac-arrow-purple)" />
            )}
            {/* average measured vector */}
            {avgPx && (
              <line x1={origin.px} y1={origin.py} x2={avgPx.px} y2={avgPx.py}
                stroke="#F97316" strokeWidth="2.8" strokeLinecap="round"
                markerEnd="url(#gac-arrow-orange)" />
            )}

            <circle cx={origin.px} cy={origin.py} r="2.5" fill="#94a3b8" />
          </g>
        </svg>

        <div style={{ fontSize: 12, color: "#475569", flex: 1, minWidth: 140 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#6B21A8", flexShrink: 0 }} />
            มาตรฐาน: {angleStandard !== null ? `${angleStandard.toFixed(1)}°` : "—"}
            {hasStandard && <span style={{ color: "#94a3b8" }}> (X={sx}, Y={sy})</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#F97316", flexShrink: 0 }} />
            ค่าเฉลี่ยที่วัดได้: {angleMeasured !== null ? `${angleMeasured.toFixed(1)}°` : "—"}
            {hasAvg && <span style={{ color: "#94a3b8" }}> (X={avgX.toFixed(3)}, Y={avgY.toFixed(3)})</span>}
          </div>
          {validPoints.length > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, color: "#94a3b8", fontSize: 10.5 }}>
              <span style={{ width: 10, height: 2, background: "#FB923C", flexShrink: 0 }} />
              เส้นประจาง = แนวจุดที่กรอกจริงทีละจุด (#1→#10)
            </div>
          )}
          {angleDiff !== null ? (
            <div style={{
              padding: "8px 10px", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0",
              fontWeight: 700, color: "#0f172a", fontSize: 13,
            }}>
              เปลี่ยนไป {Math.abs(angleDiff).toFixed(1)}°
              {angleDiffPercent !== null && ` (${angleDiffPercent.toFixed(1)}%)`}
            </div>
          ) : (
            <div style={{ color: "#94a3b8", fontSize: 11 }}>
              กรอกค่ามาตรฐานและค่าที่วัดอย่างน้อย 1 จุดเพื่อคำนวณ
            </div>
          )}
          <div style={{ fontSize: 9.5, color: "#cbd5e1", marginTop: 10 }}>
            ลากเพื่อเลื่อนมุมมอง · scroll/ปุ่ม +− เพื่อซูม
          </div>
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
