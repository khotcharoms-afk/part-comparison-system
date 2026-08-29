function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function vectorPoint(cx, cy, angleDeg, r) {
  const rad = toRad(angleDeg);
  return {
    x: cx + r * Math.cos(rad),
    y: cy - r * Math.sin(rad), // flip because SVG y grows downward
  };
}

/**
 * Pure calculation shared between the chart and the save-to-Firestore payload.
 * Angle is derived from atan2(y, x) in degrees, standard math convention
 * (0° = +X axis, counter-clockwise positive).
 */
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

export default function GainAngleChart({ standardX, standardY, measuredX, measuredY }) {
  const { angleStandard, angleMeasured, angleDiff, angleDiffPercent } =
    computeAngleInfo(standardX, standardY, measuredX, measuredY);

  const size = 220, cx = size / 2, cy = size / 2, r = 80;
  const stdPoint = angleStandard !== null ? vectorPoint(cx, cy, angleStandard, r) : null;
  const measPoint = angleMeasured !== null ? vectorPoint(cx, cy, angleMeasured, r) : null;

  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 10 }}>
        มุมจาก Gain X / Gain Y
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
          <defs>
            <marker id="gac-arrow-purple" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#6B21A8" />
            </marker>
            <marker id="gac-arrow-orange" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#F97316" />
            </marker>
          </defs>

          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth="1" strokeDasharray="4 3" />
          <line x1={cx - r - 10} y1={cy} x2={cx + r + 10} y2={cy} stroke="#f1f5f9" strokeWidth="1" />
          <line x1={cx} y1={cy - r - 10} x2={cx} y2={cy + r + 10} stroke="#f1f5f9" strokeWidth="1" />

          {stdPoint && (
            <line x1={cx} y1={cy} x2={stdPoint.x} y2={stdPoint.y}
              stroke="#6B21A8" strokeWidth="2.5" strokeDasharray="6 3" markerEnd="url(#gac-arrow-purple)" />
          )}
          {measPoint && (
            <line x1={cx} y1={cy} x2={measPoint.x} y2={measPoint.y}
              stroke="#F97316" strokeWidth="2.5" markerEnd="url(#gac-arrow-orange)" />
          )}
          <circle cx={cx} cy={cy} r="3" fill="#94a3b8" />
        </svg>

        <div style={{ fontSize: 12, color: "#475569", flex: 1, minWidth: 140 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#6B21A8", flexShrink: 0 }} />
            มาตรฐาน: {angleStandard !== null ? `${angleStandard.toFixed(1)}°` : "—"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#F97316", flexShrink: 0 }} />
            วัดได้: {angleMeasured !== null ? `${angleMeasured.toFixed(1)}°` : "—"}
          </div>
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
              กรอกค่ามาตรฐานและค่าที่วัดให้ครบเพื่อคำนวณ
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
