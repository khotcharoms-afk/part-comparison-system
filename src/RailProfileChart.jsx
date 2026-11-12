import { useState } from "react";

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

/* ------------------------------ chart ------------------------------ */

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

export default function RailProfileChart({ standardPoints, points, rail }) {
  const [hover, setHover] = useState(null);
  const r = railSettings(rail);
  const S = toPolyline(standardPoints);
  const M = toPolyline(points);
  const d = diagnoseRail({ points, standardPoints, rail });

  const size = 760, height = 460, ml = 58, mr = 24, mt = 40, mb = 52;
  const plotW = size - ml - mr, plotH = height - mt - mb;

  const xs = [...S.map(p => p.x), ...M.map(p => p.x), ...r.limits.map(l => l.x)];
  const ys = [...S.map(p => p.y), ...M.map(p => p.y), ...r.limits.map(l => l.y)];
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const padX = (xMax - xMin) * 0.03 || 1, padY = (yMax - yMin) * 0.1 || 1;
  const X0 = xMin - padX, X1 = xMax + padX, Y0 = yMin - padY, Y1 = yMax + padY;
  const px = x => ml + ((x - X0) / (X1 - X0)) * plotW;
  const py = y => mt + (1 - (y - Y0) / (Y1 - Y0)) * plotH;
  const path = poly => poly.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(2)},${py(p.y).toFixed(2)}`).join(" ");

  // per-point status for markers: vertical loss on the tread, nothing special on the flange
  const pointStatus = p => {
    if (p.x < r.boundaryX) return "ok";
    const sy = yAt(S, p.x);
    if (sy === null) return "ok";
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
      <div style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>โปรไฟล์ล้อรถไฟ เทียบกับมาตรฐาน</div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>
        แกน X / Y เป็น mm · เส้นประ = มาตรฐาน (ล้อใหม่) · เส้นทึบ = ที่วัดได้ · วัดแล้ว {M.length} จุด
      </div>

      {/* headline numbers */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        {[["Tread Wear", d.treadWear, d.treadLevel], ["Flange Wear", d.flangeWear, d.flangeLevel]].map(([label, v, lv]) => {
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

      <svg width="100%" viewBox={`0 0 ${size} ${height}`}
        style={{ display: "block", height: "auto", aspectRatio: `${size} / ${height}`, background: "#fcfdff", borderRadius: 8 }}>
        <defs>
          <clipPath id="rail-clip"><rect x={ml} y={mt} width={plotW} height={plotH} /></clipPath>
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
        {bx >= ml && bx <= ml + plotW && (
          <g>
            <line x1={bx} x2={bx} y1={mt - 28} y2={mt + plotH} stroke="#2563EB" strokeDasharray="2 4" strokeWidth="1.4" />
            <text x={bx - 8} y={mt - 14} fontSize="12" fill="#334155" textAnchor="end" fontWeight="700">⇐ Flange</text>
            <text x={bx + 8} y={mt - 14} fontSize="12" fill="#334155" fontWeight="700">Tread ⇒</text>
          </g>
        )}

        <g clipPath="url(#rail-clip)">
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
        <span>✱ = จุดขีดจำกัด</span>
      </div>
    </div>
  );
}
