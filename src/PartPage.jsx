import { useState, useEffect, useMemo, useRef, forwardRef } from "react";
import {
  collection, addDoc, onSnapshot, query, orderBy,
  doc, updateDoc, deleteDoc, serverTimestamp
} from "firebase/firestore";
import { db } from "./firebase";
import Part3DView from "./Part3DView.jsx";
import CaliperConnector from "./CaliperConnector.jsx";
import GainAngleChart, { computeAngleInfo, computeAveragePoint, diagnoseProfile } from "./GainAngleChart.jsx";

// Theme — blue/slate, matching the Gain chart colors
const PRIMARY = "#2563EB";
const PRIMARY_DARK = "#1E3A8A";
const PRIMARY_LIGHT = "#EFF6FF";
const PRIMARY_BORDER = "#BFDBFE";
const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#e2e8f0";

// Re-renders on window resize so layouts switch between phone / desktop without a reload.
function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1200));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}

function formatDateTime(ts) {
  const d = ts?.toDate ? ts.toDate() : null;
  if (!d) return "";
  return d.toLocaleString("th-TH", {
    day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function WheelIcon({ size = 20, color = "#fff" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
    </svg>
  );
}

const FIELDS = [
  { key: "diameter", label: "เส้นผ่านศูนย์กลาง (cm)" },
  { key: "thickness", label: "ความหนา (cm)" },
];

// Gain X/Y aren't part of the diameter/thickness threshold system — both the standard
// and each inspection collect up to 10 (x,y) points, averaged to derive an angle
// (atan2) and compare standard vs measured orientation.

// Parse a form value to a number, keeping 0 (unlike `parseFloat(v) || null`).
function toNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function calcDiff(measured, standard) {
  const m = parseFloat(measured);
  const s = parseFloat(standard);
  if (isNaN(m) || isNaN(s) || s === 0) return null;
  return Math.abs((m - s) / s) * 100;
}

function statusFromDiff(diff, thresholds) {
  if (diff === null) return null;
  const warning = thresholds?.warning ?? 5;
  const critical = thresholds?.critical ?? 10;
  if (diff > critical) return "critical";
  if (diff >= warning) return "warning";
  return "ok";
}

const STATUS_META = {
  ok: { icon: "✅", label: "ปกติ", color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  warning: { icon: "⚠️", label: "ติดตาม", color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  critical: { icon: "🔴", label: "เปลี่ยน", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
};

// Visual (no-tool) surface condition checklist for the wheel/tread.
// severity "critical" items force a 🔴, "warning" items force at least ⚠️ if nothing worse is checked.
const CONDITION_ITEMS = [
  { key: "cracks", label: "แตกลายงา", severity: "critical" },
  { key: "flatSpot", label: "จุดแบน/เป็นเหลี่ยม", severity: "critical" },
  { key: "delamination", label: "ผิวหลุดล่อน", severity: "critical" },
  { key: "bulging", label: "บวม/นูน", severity: "warning" },
  { key: "debris", label: "สิ่งแปลกปลอมฝังติด", severity: "warning" },
];

const emptyCondition = CONDITION_ITEMS.reduce((acc, c) => ({ ...acc, [c.key]: false }), {});

function conditionStatusFrom(condition) {
  const checked = CONDITION_ITEMS.filter(c => condition[c.key]);
  if (checked.length === 0) return "ok";
  if (checked.some(c => c.severity === "critical")) return "critical";
  return "warning";
}

export default function PartPage({ currentUser, onBack, onChangeUser }) {
  const [tab, setTab] = useState("inspect"); // "inspect" | "standards"
  const [standards, setStandards] = useState([]);
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);

  const canManageStandards = currentUser?.role === "admin" || currentUser?.role === "dev";

  useEffect(() => {
    const unsub1 = onSnapshot(
      query(collection(db, "partStandards"), orderBy("model")),
      (snap) => {
        setStandards(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
      }
    );
    const unsub2 = onSnapshot(
      query(collection(db, "partInspections"), orderBy("createdAt", "desc")),
      (snap) => setInspections(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    return () => { unsub1(); unsub2(); };
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "#f1f5f9" }}>
      {/* Header */}
      <div style={{
        background: "#fff", borderBottom: `1px solid ${LINE}`,
        position: "sticky", top: 0, zIndex: 40,
      }}>
        <div style={{
          maxWidth: 1200, margin: "0 auto", padding: "12px 16px",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          {onBack && (
            <button onClick={onBack} style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 18, color: "#475569", padding: 4,
            }}>←</button>
          )}
          <div style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: `linear-gradient(135deg, ${PRIMARY}, ${PRIMARY_DARK})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 2px 8px rgba(37,99,235,0.25)",
          }}><WheelIcon /></div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: INK, lineHeight: 1.2 }}>ตรวจสภาพล้อ</div>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>Wheel Condition Inspection</div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontSize: 12, color: "#334155", background: "#f1f5f9", border: `1px solid ${LINE}`,
              borderRadius: 999, padding: "5px 10px", maxWidth: 160,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>👤 {currentUser?.name}</span>
            {onChangeUser && (
              <button onClick={onChangeUser} title="เปลี่ยนชื่อผู้ใช้" style={{
                background: "none", border: "none", color: PRIMARY, fontSize: 11,
                fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 4,
              }}>เปลี่ยน</button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 16px 12px" }}>
          <div style={{
            display: "inline-flex", gap: 4, padding: 4, background: "#f1f5f9",
            borderRadius: 10, border: `1px solid ${LINE}`,
          }}>
            <TabButton active={tab === "inspect"} onClick={() => setTab("inspect")}>
              📋 บันทึกค่าตรวจวัด
            </TabButton>
            <TabButton active={tab === "standards"} onClick={() => setTab("standards")}>
              📐 ค่ามาตรฐาน
            </TabButton>
          </div>
        </div>
      </div>

      <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", color: "#94a3b8", padding: 40 }}>กำลังโหลด...</div>
        ) : tab === "standards" ? (
          <StandardsTab
            standards={standards}
            canManage={canManageStandards}
            currentUser={currentUser}
          />
        ) : (
          <InspectTab
            standards={standards}
            inspections={inspections}
            currentUser={currentUser}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? "#fff" : "transparent", border: "none", cursor: "pointer",
      padding: "8px 14px", fontSize: 13, fontWeight: 700, borderRadius: 7,
      color: active ? PRIMARY : MUTED,
      boxShadow: active ? "0 1px 3px rgba(15,23,42,0.12)" : "none",
      fontFamily: "inherit",
    }}>
      {children}
    </button>
  );
}

/* ---------------- STANDARDS TAB ---------------- */

const emptyStandardForm = {
  model: "", partType: "",
  diameter: "", thickness: "",
  warning: 5, critical: 10,
  modelUrl: "",
};
const emptyGainPoints = (n = 10) => Array.from({ length: n }, () => ({ x: "", y: "" }));
const strOrEmpty = v => (v === null || v === undefined ? "" : String(v));
// Gain X is entered by the user; if left blank (but Y is filled) it defaults to the point number.
const effGain = (points) => points.map((p, i) => ({
  x: p.x !== "" ? p.x : (p.y !== "" ? String(i + 1) : ""),
  y: p.y,
}));
const resizeGain = (prev, n) => Array.from({ length: n }, (_, i) => prev[i] || { x: "", y: "" });
const GAIN_POINT_OPTIONS = [10, 15, 20];
const MIN_POINTS = 3, MAX_POINTS = 60;

function StandardsTab({ standards, canManage, currentUser }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyStandardForm);
  const [pointCount, setPointCount] = useState(10);
  const [gainPoints, setGainPoints] = useState(() => emptyGainPoints(10));
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const updateGainPoint = (idx, axis, val) => {
    setGainPoints(prev => prev.map((p, i) => (i === idx ? { ...p, [axis]: val } : p)));
  };

  const changePointCount = (n) => {
    setPointCount(n);
    setGainPoints(prev => resizeGain(prev, n));
  };

  const openNew = () => {
    setImportOpen(false);
    setForm(emptyStandardForm);
    setPointCount(10);
    setGainPoints(emptyGainPoints(10));
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (s) => {
    setImportOpen(false);
    setForm({
      model: s.model || "",
      partType: s.partType || "",
      diameter: s.specs?.diameter ?? "",
      thickness: s.specs?.thickness ?? "",
      warning: s.thresholds?.warning ?? 5,
      critical: s.thresholds?.critical ?? 10,
      modelUrl: s.modelUrl || "",
    });
    if (Array.isArray(s.specs?.gainPoints) && s.specs.gainPoints.length > 0) {
      const count = s.specs.gainPoints.length;
      const pts = s.specs.gainPoints.map(p => ({ x: strOrEmpty(p?.x), y: strOrEmpty(p?.y) }));
      setPointCount(count);
      setGainPoints(pts);
    } else {
      // backward compat with the old single gainX/gainY format
      const pts = emptyGainPoints(10);
      if (s.specs?.gainX != null || s.specs?.gainY != null) {
        pts[0] = { x: strOrEmpty(s.specs.gainX), y: strOrEmpty(s.specs.gainY) };
      }
      setPointCount(10);
      setGainPoints(pts);
    }
    setEditingId(s.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.model.trim() || !form.partType.trim()) {
      alert("กรุณากรอกรุ่นและประเภทอะไหล่");
      return;
    }
    const warn = toNum(form.warning) ?? 5;
    const crit = toNum(form.critical) ?? 10;
    if (warn >= crit) {
      alert("เกณฑ์ ⚠️ เตือน ต้องน้อยกว่า 🔴 วิกฤต");
      return;
    }
    setSaving(true);
    const filledGain = effGain(gainPoints);
    const gainAvg = computeAveragePoint(filledGain);
    const payload = {
      model: form.model.trim(),
      partType: form.partType.trim(),
      specs: {
        diameter: toNum(form.diameter) ?? 0,
        thickness: toNum(form.thickness) ?? 0,
        gainPoints: filledGain.map(p => ({
          x: toNum(p.x),
          y: toNum(p.y),
        })),
        gainAverage: { x: gainAvg.avgX, y: gainAvg.avgY, count: gainAvg.count },
      },
      thresholds: {
        warning: warn,
        critical: crit,
      },
      modelUrl: form.modelUrl.trim(),
      updatedBy: currentUser?.name || "unknown",
      updatedAt: serverTimestamp(),
    };
    try {
      if (editingId) {
        await updateDoc(doc(db, "partStandards", editingId), payload);
      } else {
        await addDoc(collection(db, "partStandards"), {
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      setShowForm(false);
    } catch (e) {
      alert("บันทึกไม่สำเร็จ: " + e.message);
    }
    setSaving(false);
  };

  const handleDelete = async (id) => {
    if (!confirm("ลบค่ามาตรฐานนี้?")) return;
    try {
      await deleteDoc(doc(db, "partStandards", id));
    } catch (e) {
      alert("ลบไม่สำเร็จ: " + e.message);
    }
  };

  return (
    <div>
      {canManage && (
        <button onClick={openNew} style={{
          width: "100%", background: PRIMARY, color: "#fff", border: "none",
          borderRadius: 10, padding: "12px", fontSize: 14, fontWeight: 700,
          cursor: "pointer", marginBottom: 16, fontFamily: "inherit",
        }}>
          + เพิ่มค่ามาตรฐาน
        </button>
      )}

      {standards.length === 0 && (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: 30, fontSize: 13 }}>
          ยังไม่มีค่ามาตรฐาน{canManage ? " — กดปุ่มด้านบนเพื่อเพิ่ม" : ""}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {standards.map((s) => (
          <div key={s.id} style={{
            background: "#fff", border: `1px solid ${LINE}`, borderRadius: 14, padding: 16,
            boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
                  {s.model} <span style={{ color: "#94a3b8", fontWeight: 500 }}>· {s.partType}</span>
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                  ⚠️ ≥{s.thresholds?.warning}% &nbsp;|&nbsp; 🔴 &gt;{s.thresholds?.critical}%
                </div>
              </div>
              {canManage && (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => openEdit(s)} style={smallBtnStyle("#f1f5f9", "#475569")}>แก้ไข</button>
                  <button onClick={() => handleDelete(s.id)} style={smallBtnStyle("#fef2f2", "#dc2626")}>ลบ</button>
                </div>
              )}
            </div>
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 10,
            }}>
              {FIELDS.map(f => (
                <div key={f.key} style={{
                  background: PRIMARY_LIGHT, border: `1px solid ${PRIMARY_BORDER}`,
                  borderRadius: 8, padding: "6px 8px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 10, color: PRIMARY, fontWeight: 600 }}>{f.label}</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: PRIMARY_DARK }}>{s.specs?.[f.key]}</div>
                </div>
              ))}
            </div>
            {(s.specs?.gainAverage?.x != null || s.specs?.gainAverage?.y != null) && (
              <div style={{
                display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 8,
              }}>
                <div style={{
                  background: "#f8fafc", border: `1px solid ${LINE}`,
                  borderRadius: 8, padding: "6px 8px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>Gain X (เฉลี่ย)</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#334155" }}>
                    {s.specs.gainAverage.x != null ? s.specs.gainAverage.x.toFixed(2) : "—"}
                  </div>
                </div>
                <div style={{
                  background: "#f8fafc", border: `1px solid ${LINE}`,
                  borderRadius: 8, padding: "6px 8px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>จำนวนจุด Gain</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#334155" }}>
                    {s.specs.gainAverage.count ?? "—"}
                  </div>
                </div>
                <div style={{
                  background: "#f8fafc", border: `1px solid ${LINE}`,
                  borderRadius: 8, padding: "6px 8px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>Gain Y (เฉลี่ย)</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#334155" }}>
                    {s.specs.gainAverage.y != null ? s.specs.gainAverage.y.toFixed(2) : "—"}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {showForm && (
        <div style={modalOverlayStyle} onClick={() => setShowForm(false)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 14, color: "#0f172a" }}>
              {editingId ? "แก้ไขค่ามาตรฐาน" : "เพิ่มค่ามาตรฐาน"}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <FormField label="รุ่น (model)" value={form.model}
                onChange={v => setForm({ ...form, model: v })} placeholder="เช่น SC80" />
              <FormField label="ประเภทอะไหล่" value={form.partType}
                onChange={v => setForm({ ...form, partType: v })} placeholder="เช่น ล้อ" />
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", margin: "12px 0 8px" }}>
              ค่ามาตรฐาน (specs)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              {FIELDS.map(f => (
                <FormField key={f.key} label={f.label} type="number" value={form[f.key]}
                  onChange={v => setForm({ ...form, [f.key]: v })} />
              ))}
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", margin: "12px 0 4px" }}>
              Gain X / Gain Y รายจุด (โปรไฟล์หน้ายาง) — ไม่บังคับ
            </div>
            <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 8 }}>
              กรอกเรียงจากขอบซ้าย (#1) ไปขอบขวา · ถ้าเว้น X ว่างไว้ ระบบใช้เลขลำดับจุดแทน
              · ตอนตรวจเลือกจำนวนจุดต่างจากนี้ได้ ระบบเทียบตามตำแหน่งบนหน้ายางให้
            </div>

            {importOpen ? (
              <GainImportPanel
                hasValues={gainPoints.some(p => p.x !== "" || p.y !== "")}
                onClose={() => setImportOpen(false)}
                onImport={pts => { setGainPoints(pts); setPointCount(pts.length); setImportOpen(false); }}
              />
            ) : null}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>ความละเอียด:</span>
              {GAIN_POINT_OPTIONS.map(n => (
                <button key={n} type="button" onClick={() => changePointCount(n)} style={{
                  padding: "4px 12px", borderRadius: 6,
                  border: pointCount === n ? `1px solid ${PRIMARY}` : `1px solid ${LINE}`,
                  background: pointCount === n ? PRIMARY_LIGHT : "#fff",
                  color: pointCount === n ? PRIMARY : "#475569",
                  fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                }}>{n} จุด</button>
              ))}
              {!GAIN_POINT_OPTIONS.includes(pointCount) && (
                <span style={{ fontSize: 12, fontWeight: 700, color: PRIMARY }}>{pointCount} จุด</span>
              )}
              {!importOpen && (
                <button type="button" onClick={() => setImportOpen(true)} style={{
                  marginLeft: "auto", background: "#fff", color: PRIMARY,
                  border: `1px solid ${PRIMARY_BORDER}`, borderRadius: 7,
                  padding: "4px 10px", fontSize: 11, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
                }}>📋 วางค่า (Import)</button>
              )}
            </div>

            <div style={{
              display: "grid", gridTemplateColumns: "1fr", gap: "4px", marginBottom: 14,
            }}>
              {gainPoints.map((p, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 10, color: "#94a3b8", width: 20, flexShrink: 0 }}>#{i + 1}</span>
                  <input
                    type="number" placeholder={`X (${i + 1})`} value={p.x}
                    onChange={e => updateGainPoint(i, "x", e.target.value)}
                    style={{
                      flex: 1, minWidth: 0, border: "1px solid #e2e8f0", borderRadius: 6,
                      padding: "4px 6px", fontSize: 11, fontFamily: "inherit", boxSizing: "border-box",
                    }}
                  />
                  <input
                    type="number" placeholder="Y" value={p.y}
                    onChange={e => updateGainPoint(i, "y", e.target.value)}
                    style={{
                      flex: 1, minWidth: 0, border: "1px solid #e2e8f0", borderRadius: 6,
                      padding: "4px 6px", fontSize: 11, fontFamily: "inherit", boxSizing: "border-box",
                    }}
                  />
                </div>
              ))}
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", margin: "12px 0 8px" }}>
              เกณฑ์เตือน (% ค่าเบี่ยงเบน)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
              <FormField label="⚠️ เตือน (≥%)" type="number" value={form.warning}
                onChange={v => setForm({ ...form, warning: v })} />
              <FormField label="🔴 วิกฤต (>%)" type="number" value={form.critical}
                onChange={v => setForm({ ...form, critical: v })} />
            </div>

            <div style={{ marginBottom: 18 }}>
              <FormField label="ลิงก์โมเดล 3D (.glb) — ไม่บังคับ" value={form.modelUrl}
                onChange={v => setForm({ ...form, modelUrl: v })}
                placeholder="https://... (Cloudinary / Firebase Storage)" />
              <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>
                ตั้งชื่อชิ้นส่วนในไฟล์ให้มีคำว่า diameter / thickness ปนอยู่ ระบบจะลงสีให้อัตโนมัติ
                ถ้าเว้นว่างไว้ ระบบจะแสดงแบบจำลองทรงล้อทั่วไปแทน
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowForm(false)} style={{
                flex: 1, background: "#f1f5f9", border: "none", color: "#475569",
                borderRadius: 8, padding: "11px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              }}>ยกเลิก</button>
              <button onClick={handleSave} disabled={saving} style={{
                flex: 1, background: PRIMARY, border: "none", color: "#fff",
                borderRadius: 8, padding: "11px", fontWeight: 700, cursor: "pointer",
                fontFamily: "inherit", opacity: saving ? 0.6 : 1,
              }}>{saving ? "กำลังบันทึก..." : "บันทึก"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- INSPECT TAB ---------------- */

// Input sequence for the caliper / Enter key:
//   diameter → thickness → existing Gain cells → "append" slot (each value adds a new point)
const APPEND_KEY = "gain:append";
function targetKey(t) {
  if (t.kind === "field") return `field:${t.key}`;
  if (t.kind === "append") return APPEND_KEY;
  return `gain:${t.idx}:${t.axis}`;
}
function buildTargetList(gainCount, mode) {
  const targets = FIELDS.map(f => ({ kind: "field", key: f.key }));
  for (let i = 0; i < gainCount; i++) {
    if (mode === "xy") targets.push({ kind: "gain", idx: i, axis: "x" });
    targets.push({ kind: "gain", idx: i, axis: "y" });
  }
  targets.push({ kind: "append" });
  return targets;
}
const loadEntryMode = () => {
  try { return localStorage.getItem("pcs_gain_mode") === "xy" ? "xy" : "y"; } catch { return "y"; }
};

function InspectTab({ standards, inspections, currentUser }) {
  const [selectedId, setSelectedId] = useState("");
  const [serialNo, setSerialNo] = useState("");
  const [values, setValues] = useState({ diameter: "", thickness: "" });
  const [gainPoints, setGainPoints] = useState([]);
  const [saving, setSaving] = useState(false);
  const [entryMode, setEntryModeState] = useState(loadEntryMode); // "y" = one value per point, "xy" = X then Y
  const setEntryMode = (m) => {
    setEntryModeState(m);
    try { localStorage.setItem("pcs_gain_mode", m); } catch { /* ignore */ }
  };
  const [appendDraft, setAppendDraft] = useState("");
  const appendRef = useRef(null);
  const [activeTargetKey, setActiveTargetKey] = useState(`field:${FIELDS[0].key}`);
  const fieldRefs = useRef({});
  const gainRefs = useRef({});
  const [condition, setCondition] = useState(emptyCondition);
  const [conditionNote, setConditionNote] = useState("");
  const vw = useViewportWidth();
  const stackGain = vw < 760;      // table above chart instead of side-by-side
  const narrow = vw < 500;

  const selected = standards.find(s => s.id === selectedId);
  // Ignore empty rows at the end (e.g. a row added with "+ เพิ่มจุด" but not filled yet)
  const filledGain = useMemo(() => {
    let n = gainPoints.length;
    while (n > 0 && gainPoints[n - 1].x === "" && gainPoints[n - 1].y === "") n--;
    return effGain(gainPoints.slice(0, n));
  }, [gainPoints]);
  const stdGainCount = selected?.specs?.gainPoints?.length || 0;
  const [importOpen, setImportOpen] = useState(false);

  const targetList = useMemo(() => buildTargetList(gainPoints.length, entryMode), [gainPoints.length, entryMode]);

  // New model → start with an empty Gain table; points are added as they're measured.
  useEffect(() => {
    setGainPoints([]);
    setAppendDraft("");
    setActiveTargetKey(`field:${FIELDS[0].key}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const liveResults = useMemo(() => {
    if (!selected) return {};
    const out = {};
    FIELDS.forEach(f => {
      const diff = calcDiff(values[f.key], selected.specs?.[f.key]);
      out[f.key] = { diff, status: statusFromDiff(diff, selected.thresholds) };
    });
    return out;
  }, [values, selected]);

  const overallStatus = useMemo(() => {
    const statuses = Object.values(liveResults).map(r => r.status).filter(Boolean);
    if (statuses.length === 0) return null;
    if (statuses.includes("critical")) return "critical";
    if (statuses.includes("warning")) return "warning";
    return "ok";
  }, [liveResults]);

  const conditionStatus = useMemo(() => conditionStatusFrom(condition), [condition]);
  const anyConditionChecked = CONDITION_ITEMS.some(c => condition[c.key]);

  // Gain profile diagnosis (same logic the chart shows) — used for the hint in the
  // surface checklist, the combined result and the saved record.
  const gainDiag = useMemo(() => {
    if (!selected) return { level: null, findings: [], worn: [], bulge: [] };
    const sp = selected.specs?.gainPoints || [];
    return diagnoseProfile({
      points: filledGain,
      standardPoints: sp,
      standardY: selected.specs?.gainAverage?.y,
      thresholds: selected.thresholds,
    });
  }, [selected, filledGain]);

  // Final result = the worst of: size (diameter/thickness), Gain profile, surface condition
  const RANK = { ok: 0, warning: 1, critical: 2 };
  const resultParts = useMemo(() => {
    const parts = [];
    if (overallStatus) {
      const bad = FIELDS.filter(f => liveResults[f.key]?.status && liveResults[f.key].status !== "ok")
        .map(f => `${f.label.replace(/ \(cm\)/, "")} ${liveResults[f.key].diff.toFixed(1)}%`);
      parts.push({ key: "size", label: "ขนาด (เส้นผ่านศูนย์กลาง/ความหนา)", status: overallStatus,
        detail: bad.length ? `เบี่ยง: ${bad.join(", ")}` : "อยู่ในเกณฑ์" });
    }
    if (gainDiag.level) {
      const bits = [];
      if (gainDiag.worn.length) bits.push(`สึก ${gainDiag.wornRange}`);
      if (gainDiag.bulge.length) bits.push(`นูน ${gainDiag.bulgeRange}`);
      parts.push({ key: "gain", label: "โปรไฟล์หน้ายาง (Gain Y)", status: gainDiag.level,
        detail: bits.length ? bits.join(" · ") : "อยู่ในเกณฑ์" });
    }
    if (anyConditionChecked) {
      parts.push({ key: "surface", label: "สภาพผิว", status: conditionStatus,
        detail: CONDITION_ITEMS.filter(c => condition[c.key]).map(c => c.label).join(", ") });
    }
    return parts;
  }, [overallStatus, liveResults, gainDiag, anyConditionChecked, conditionStatus, condition]);
  const finalStatus = resultParts.length
    ? resultParts.reduce((w, p) => (RANK[p.status] > RANK[w] ? p.status : w), "ok")
    : null;

  const gainAverage = useMemo(() => computeAveragePoint(filledGain), [filledGain]);

  const angleInfo = useMemo(
    () => computeAngleInfo(
      selected?.specs?.gainAverage?.x, selected?.specs?.gainAverage?.y,
      gainAverage.avgX, gainAverage.avgY
    ),
    [selected, gainAverage.avgX, gainAverage.avgY]
  );

  const updateGainPoint = (idx, axis, val) => {
    setGainPoints(prev => prev.map((p, i) => (i === idx ? { ...p, [axis]: val } : p)));
  };

  const anyGainEntered = gainPoints.some(p => p.x !== "" || p.y !== "");

  const focusTarget = (t) => {
    if (!t) return;
    setActiveTargetKey(targetKey(t));
    requestAnimationFrame(() => {
      if (t.kind === "field") fieldRefs.current[t.key]?.focus();
      else if (t.kind === "append") appendRef.current?.focus();
      else gainRefs.current[`${t.idx}-${t.axis}`]?.focus();
    });
  };
  // Move from a target to the next one (no wrap-around; the end is the append slot)
  const advanceFrom = (key) => {
    const i = targetList.findIndex(t => targetKey(t) === key);
    focusTarget(targetList[Math.min((i >= 0 ? i : 0) + 1, targetList.length - 1)]);
  };

  // A value for a NEW point (from the caliper, or typed in the append slot + Enter)
  const appendValue = (raw) => {
    const v = String(raw).trim();
    if (v === "" || !Number.isFinite(parseFloat(v))) return;
    if (gainPoints.length >= MAX_POINTS) { alert(`วัดได้สูงสุด ${MAX_POINTS} จุด`); return; }
    const idx = gainPoints.length;
    if (entryMode === "xy") {
      setGainPoints(prev => [...prev, { x: v, y: "" }]);
      focusTarget({ kind: "gain", idx, axis: "y" });
    } else {
      setGainPoints(prev => [...prev, { x: "", y: v }]);
      focusTarget({ kind: "append" });
    }
  };
  const addEmptyPoint = () => {
    if (gainPoints.length >= MAX_POINTS) return;
    const idx = gainPoints.length;
    setGainPoints(prev => [...prev, { x: "", y: "" }]);
    focusTarget({ kind: "gain", idx, axis: entryMode === "xy" ? "x" : "y" });
  };
  const removeLastPoint = () => {
    if (gainPoints.length === 0) return;
    setGainPoints(prev => prev.slice(0, -1));
    focusTarget({ kind: "append" });
  };
  const clearGain = () => {
    if (!anyGainEntered && gainPoints.length === 0) return;
    if (anyGainEntered && !confirm("ล้างค่า Gain ทั้งหมด?")) return;
    setGainPoints([]);
    setAppendDraft("");
    focusTarget({ kind: "append" });
  };
  const onEnterAdvance = (key) => (e) => {
    if (e.key === "Enter") { e.preventDefault(); advanceFrom(key); }
  };

  const resetForm = () => {
    setSerialNo("");
    setValues({ diameter: "", thickness: "" });
    setGainPoints([]);
    setAppendDraft("");
    setActiveTargetKey(`field:${FIELDS[0].key}`);
    setCondition(emptyCondition);
    setConditionNote("");
  };

  // Caliper values fill whichever field/cell is active, then move on. When the
  // append slot is active (the default once the existing cells are done), every
  // value adds a new Gain point — so the number of points is whatever was measured.
  const handleCaliperValue = (num) => {
    if (!selected) return;
    const i = targetList.findIndex(t => targetKey(t) === activeTargetKey);
    const current = i >= 0 ? targetList[i] : targetList[0];
    if (!current) return;
    if (current.kind === "append") { appendValue(num); return; }
    if (current.kind === "field") {
      setValues(prev => ({ ...prev, [current.key]: String(num) }));
    } else {
      setGainPoints(prev => prev.map((p, k) => (k === current.idx ? { ...p, [current.axis]: String(num) } : p)));
    }
    advanceFrom(targetKey(current));
  };

  const handleSubmit = async () => {
    if (!selected) { alert("กรุณาเลือกรุ่น/ประเภทอะไหล่"); return; }
    const anyFilled = Object.values(values).some(v => v !== "");
    const anyGainFilled = gainAverage.count > 0;
    if (!anyFilled && !anyConditionChecked && !anyGainFilled) {
      alert("กรุณากรอกค่าที่วัด หรือติ๊กสภาพผิวอย่างน้อย 1 อย่าง");
      return;
    }

    setSaving(true);
    try {
      await addDoc(collection(db, "partInspections"), {
        model: selected.model,
        partType: selected.partType,
        standardId: selected.id,
        serialNo: serialNo.trim(),
        values: {
          diameter: toNum(values.diameter),
          thickness: toNum(values.thickness),
        },
        results: liveResults,
        overallStatus,
        gainPoints: filledGain.map(p => ({
          x: toNum(p.x),
          y: toNum(p.y),
        })),
        pointCount: filledGain.length,
        gainAverage: { x: gainAverage.avgX, y: gainAverage.avgY, count: gainAverage.count },
        angleInfo,
        gainDiagnosis: gainDiag.level
          ? { level: gainDiag.level, verdict: gainDiag.verdict, findings: gainDiag.findings.map(f => f.text) }
          : null,
        finalStatus,
        finalParts: resultParts.map(p => ({ part: p.key, status: p.status, detail: p.detail })),
        condition,
        conditionNote: conditionNote.trim(),
        conditionStatus,
        inspectedBy: currentUser?.name || "unknown",
        createdAt: serverTimestamp(),
      });
      resetForm();
    } catch (e) {
      alert("บันทึกไม่สำเร็จ: " + e.message);
    }
    setSaving(false);
  };

  return (
    <div>
      <Card>
        <SectionTitle step={1} title="เลือกรุ่น / อะไหล่" />
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)} style={selectStyle}>
          <option value="">-- เลือก --</option>
          {standards.map(s => (
            <option key={s.id} value={s.id}>{s.model} · {s.partType}</option>
          ))}
        </select>

        {selected && (
          <>
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8,
              margin: "12px 0", padding: 10, background: PRIMARY_LIGHT,
              border: `1px solid ${PRIMARY_BORDER}`, borderRadius: 10,
            }}>
              {FIELDS.map(f => (
                <div key={f.key} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: PRIMARY }}>มาตรฐาน · {f.label}</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: PRIMARY_DARK }}>{selected.specs?.[f.key]}</div>
                </div>
              ))}
            </div>

            <Part3DView results={liveResults} overallStatus={overallStatus} modelUrl={selected.modelUrl || undefined} />
          </>
        )}

        <div style={{ marginTop: 14 }}>
          <FormField label="Serial No." value={serialNo} onChange={setSerialNo} placeholder="หมายเลขล้อ / หุ่นยนต์" />
        </div>
      </Card>

      <Card dim={!selected}>
        <SectionTitle step={2} title="ค่าที่วัดได้" />

        <CaliperConnector onValue={handleCaliperValue} disabled={!selected} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {FIELDS.map(f => {
            const r = liveResults[f.key];
            const meta = r?.status ? STATUS_META[r.status] : null;
            const isActive = activeTargetKey === `field:${f.key}`;
            return (
              <div key={f.key} style={{
                borderRadius: 10, padding: isActive ? 4 : 0,
                boxShadow: isActive ? `0 0 0 2px ${PRIMARY}` : "none",
              }}>
                <FormField
                  ref={el => (fieldRefs.current[f.key] = el)}
                  label={f.label} type="number" value={values[f.key]}
                  onChange={v => setValues({ ...values, [f.key]: v })}
                  onFocus={() => setActiveTargetKey(`field:${f.key}`)}
                  onKeyDown={onEnterAdvance(`field:${f.key}`)}
                  disabled={!selected}
                />
                {meta && (
                  <div style={{
                    marginTop: 4, fontSize: 11, fontWeight: 700, color: meta.color,
                    display: "flex", alignItems: "center", gap: 4,
                  }}>
                    {meta.icon} {meta.label} ({r.diff.toFixed(1)}%)
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </Card>

      <Card dim={!selected}>
        <SectionTitle step={3} title={`Gain — วัดแล้ว ${filledGain.length} จุด (ขอบซ้าย → ขวา)`} right={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {!importOpen && (
            <button type="button" disabled={!selected} onClick={() => setImportOpen(true)} style={{
              background: "#fff", color: !selected ? "#cbd5e1" : PRIMARY,
              border: `1px solid ${!selected ? LINE : PRIMARY_BORDER}`, borderRadius: 7,
              padding: "5px 10px", fontSize: 11, fontWeight: 700, fontFamily: "inherit",
              cursor: selected ? "pointer" : "default",
            }}>📋 วางค่า (Import)</button>
          )}
          <button type="button" onClick={clearGain} disabled={!anyGainEntered} style={{
            background: anyGainEntered ? "#fef2f2" : "#f8fafc",
            color: anyGainEntered ? "#dc2626" : "#cbd5e1",
            border: `1px solid ${anyGainEntered ? "#fecaca" : LINE}`, borderRadius: 7,
            padding: "5px 10px", fontSize: 11, fontWeight: 700, fontFamily: "inherit",
            cursor: anyGainEntered ? "pointer" : "default",
          }}>🗑 ล้างค่า Gain</button>
          </div>
        } />
        {importOpen && (
          <GainImportPanel
            hasValues={anyGainEntered}
            onClose={() => setImportOpen(false)}
            onImport={pts => { setGainPoints(pts); setImportOpen(false); focusTarget({ kind: "append" }); }}
          />
        )}
        {/* entry mode + point tools — the number of points is however many get measured */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: "#475569", fontWeight: 700 }}>ค่าที่ยิงต่อ 1 จุด:</span>
          <div style={{ display: "inline-flex", padding: 3, gap: 3, background: "#f1f5f9", borderRadius: 8, border: `1px solid ${LINE}` }}>
            {[["y", "Y อย่างเดียว"], ["xy", "X แล้ว Y"]].map(([m, label]) => (
              <button key={m} type="button" disabled={!selected} onClick={() => setEntryMode(m)} style={{
                border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11.5, fontWeight: 700,
                fontFamily: "inherit", cursor: selected ? "pointer" : "default",
                background: entryMode === m ? "#fff" : "transparent",
                color: entryMode === m ? PRIMARY : MUTED,
                boxShadow: entryMode === m ? "0 1px 2px rgba(15,23,42,0.12)" : "none",
              }}>{label}</button>
            ))}
          </div>
          <button type="button" disabled={!selected || gainPoints.length >= MAX_POINTS} onClick={addEmptyPoint} style={toolBtn(!selected)}>＋ เพิ่มจุด</button>
          <button type="button" disabled={!selected || gainPoints.length === 0} onClick={removeLastPoint}
            style={toolBtn(!selected || gainPoints.length === 0)}>↶ ลบจุดสุดท้าย</button>
          {stdGainCount > 0 && (
            <span style={{
              fontSize: 11, color: "#1E3A8A", background: PRIMARY_LIGHT, border: `1px solid ${PRIMARY_BORDER}`,
              borderRadius: 999, padding: "2px 8px",
            }}>
              มาตรฐานรุ่นนี้ {stdGainCount} จุด · วัดกี่จุดก็ได้ ระบบเทียบตามตำแหน่งให้
            </span>
          )}
        </div>
        <div style={{ fontSize: 10.5, color: "#94a3b8", marginBottom: 8 }}>
          วัดเรียงจากขอบซ้ายไปขอบขวา · กดส่งค่าจากเครื่องมือ 1 ครั้ง = เพิ่ม 1 จุด
          {entryMode === "xy" ? " (ยิง X แล้วตามด้วย Y)" : " (X ใช้เลขลำดับจุด)"}
          {" · "}พิมพ์เองก็ได้ กด Enter เพื่อไปช่อง/จุดถัดไป · คลิกช่องเดิมเพื่อแก้ค่าได้
        </div>
        <style>{`
          .gxy-input::-webkit-outer-spin-button,
          .gxy-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
          .gxy-input { -moz-appearance: textfield; }
        `}</style>
        <div style={{
          display: "grid",
          gridTemplateColumns: stackGain ? "1fr" : "200px minmax(0, 1fr)",
          gap: 16, alignItems: "start",
        }}>
          <div>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr",
              gap: "3px", paddingRight: 4,
            }}>
              {gainPoints.map((p, i) => {
                const isActiveX = activeTargetKey === `gain:${i}:x`;
                const isActiveY = activeTargetKey === `gain:${i}:y`;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <span style={{ fontSize: 9, color: "#94a3b8", width: 14, flexShrink: 0 }}>#{i + 1}</span>
                    {entryMode === "xy" && <input
                      className="gxy-input"
                      ref={el => (gainRefs.current[`${i}-x`] = el)}
                      type="number" placeholder={`X (${i + 1})`} value={p.x} disabled={!selected}
                      onChange={e => updateGainPoint(i, "x", e.target.value)}
                      onFocus={() => setActiveTargetKey(`gain:${i}:x`)}
                      onKeyDown={onEnterAdvance(`gain:${i}:x`)}
                      style={{
                        flex: 1, minWidth: 0, maxWidth: 80, borderRadius: 5,
                        border: isActiveX ? `1px solid ${PRIMARY}` : `1px solid ${LINE}`,
                        boxShadow: isActiveX ? `0 0 0 2px ${PRIMARY_BORDER}` : "none",
                        padding: "3px 4px", fontSize: 10.5, fontFamily: "inherit",
                        background: !selected ? "#f8fafc" : "#fff", boxSizing: "border-box",
                      }}
                    />}
                    <input
                      className="gxy-input"
                      ref={el => (gainRefs.current[`${i}-y`] = el)}
                      type="number" placeholder="Y" value={p.y} disabled={!selected}
                      onChange={e => updateGainPoint(i, "y", e.target.value)}
                      onFocus={() => setActiveTargetKey(`gain:${i}:y`)}
                      onKeyDown={onEnterAdvance(`gain:${i}:y`)}
                      style={{
                        flex: 1, minWidth: 0, maxWidth: entryMode === "xy" ? 80 : 140, borderRadius: 5,
                        border: isActiveY ? `1px solid ${PRIMARY}` : `1px solid ${LINE}`,
                        boxShadow: isActiveY ? `0 0 0 2px ${PRIMARY_BORDER}` : "none",
                        padding: "3px 4px", fontSize: 10.5, fontFamily: "inherit",
                        background: !selected ? "#f8fafc" : "#fff", boxSizing: "border-box",
                      }}
                    />
                  </div>
                );
              })}

              {/* append slot — the next value (caliper or typed + Enter) becomes a new point */}
              {(() => {
                const on = activeTargetKey === APPEND_KEY;
                const full = gainPoints.length >= MAX_POINTS;
                return (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 3, marginTop: 4, boxSizing: "border-box", maxWidth: "100%",
                    border: `1px dashed ${on ? PRIMARY : "#cbd5e1"}`, borderRadius: 7,
                    padding: "4px 4px", background: on ? PRIMARY_LIGHT : "#fff",
                  }}>
                    <span style={{ fontSize: 9, color: on ? PRIMARY : "#94a3b8", width: 14, flexShrink: 0, fontWeight: 700 }}>
                      #{gainPoints.length + 1}
                    </span>
                    <input
                      ref={appendRef}
                      className="gxy-input"
                      type="number" value={appendDraft} disabled={!selected || full}
                      placeholder={full ? `ครบ ${MAX_POINTS} จุด` : on ? "รอค่า… / พิมพ์+Enter" : "คลิกเพื่อเพิ่มจุด"}
                      onChange={e => setAppendDraft(e.target.value)}
                      onFocus={() => setActiveTargetKey(APPEND_KEY)}
                      onKeyDown={e => {
                        if (e.key === "Enter") { e.preventDefault(); appendValue(appendDraft); setAppendDraft(""); }
                      }}
                      style={{
                        flex: 1, minWidth: 0, width: 0, border: "none", outline: "none", background: "transparent",
                        fontSize: 11, fontFamily: "inherit", padding: "3px 2px",
                      }}
                    />
                    <span style={{ fontSize: 10, color: on ? PRIMARY : "#cbd5e1", fontWeight: 700, whiteSpace: "nowrap" }}>
                      {entryMode === "xy" ? "X ใหม่" : "Y ใหม่"}
                    </span>
                  </div>
                );
              })()}
              {gainPoints.length === 0 && selected && (
                <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 4, lineHeight: 1.5 }}>
                  ยังไม่มีจุด — คลิกช่องประบนนี้ แล้วกดส่งค่าจากเครื่องมือได้เลย หรือใช้ 📋 วางค่า
                </div>
              )}
            </div>
          </div>

          {selected && (selected.specs?.gainAverage?.x != null || selected.specs?.gainAverage?.y != null) && (
            <div style={{ position: stackGain ? "static" : "sticky", top: 110 }}>
              <GainAngleChart
                standardX={selected.specs?.gainAverage?.x} standardY={selected.specs?.gainAverage?.y}
                standardPoints={selected.specs?.gainPoints}
                points={filledGain} avgX={gainAverage.avgX} avgY={gainAverage.avgY} count={gainAverage.count}
                thresholds={selected.thresholds}
              />
            </div>
          )}
        </div>
      </Card>

      <Card dim={!selected}>
        <SectionTitle step={4} title="สภาพผิวหน้ายาง" hint="ตรวจด้วยสายตา ไม่ต้องใช้เครื่องมือ" />
        <div style={{
          display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(3, 1fr)", gap: 8,
          background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 12,
        }}>
          {CONDITION_ITEMS.map(c => {
            const flagged = c.key === "bulging" && gainDiag.bulge.length > 0 && !condition[c.key];
            return (
            <label key={c.key} style={{
              display: "flex", alignItems: "center", gap: 8, fontSize: 13,
              color: condition[c.key] ? "#0f172a" : "#475569", cursor: "pointer",
              fontWeight: condition[c.key] || flagged ? 700 : 500,
              ...(flagged ? { background: "#FFFBEB", outline: "1px solid #FCD34D", borderRadius: 6, padding: "2px 6px", margin: "-2px -6px" } : {}),
            }}>
              <input
                type="checkbox"
                checked={condition[c.key]}
                disabled={!selected}
                onChange={e => setCondition({ ...condition, [c.key]: e.target.checked })}
                style={{ width: 16, height: 16, accentColor: c.severity === "critical" ? "#dc2626" : "#d97706" }}
              />
              {c.label}{flagged ? " ← กราฟพบ" : ""}
            </label>
            );
          })}
        </div>
        {gainDiag.bulge.length > 0 && (
          <div style={{
            marginTop: 8, padding: "8px 12px", borderRadius: 8, fontSize: 12,
            background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E",
          }}>
            📈 กราฟ Gain พบยางนูนที่จุด <b>{gainDiag.bulgeRange}</b> — ตรวจด้วยตาตรงตำแหน่งนั้น
            ถ้าเห็นรอยบวมจริงให้ติ๊ก "บวม/นูน" เพื่อยืนยัน
          </div>
        )}
        {gainDiag.worn.length > 0 && (
          <div style={{
            marginTop: 8, padding: "8px 12px", borderRadius: 8, fontSize: 12,
            background: "#F8FAFC", border: `1px solid ${LINE}`, color: "#475569",
          }}>
            📈 กราฟ Gain พบจุดสึกที่ <b>{gainDiag.wornRange}</b> — ดูด้วยว่าบริเวณนั้นมีรอยแตกลายงา หรือผิวหลุดล่อนหรือไม่
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <FormField
            label="หมายเหตุเพิ่มเติม (ถ้ามี)" value={conditionNote}
            onChange={setConditionNote} disabled={!selected}
            placeholder="เช่น ตำแหน่งที่พบ, ความรุนแรง"
          />
        </div>
        {anyConditionChecked && (
          <div style={{
            marginTop: 8, padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 700,
            background: STATUS_META[conditionStatus].bg,
            border: `1px solid ${STATUS_META[conditionStatus].border}`,
            color: STATUS_META[conditionStatus].color,
          }}>
            {STATUS_META[conditionStatus].icon} สภาพผิว: {STATUS_META[conditionStatus].label}
          </div>
        )}

      </Card>

      <Card>
        {finalStatus && (
          <div style={{
            marginBottom: 12, padding: 12, borderRadius: 10,
            background: STATUS_META[finalStatus].bg,
            border: `1px solid ${STATUS_META[finalStatus].border}`,
          }}>
            <div style={{ textAlign: "center", color: STATUS_META[finalStatus].color, fontWeight: 800, fontSize: 15, marginBottom: 8 }}>
              {STATUS_META[finalStatus].icon} ผลรวม: {STATUS_META[finalStatus].label}
              <span style={{ fontSize: 11, fontWeight: 600, color: MUTED }}> (ใช้ผลที่แย่ที่สุดจากทุกส่วน)</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {resultParts.map(p => {
                const m = STATUS_META[p.status];
                const isWorst = p.status === finalStatus && finalStatus !== "ok";
                return (
                  <div key={p.key} style={{
                    display: "flex", gap: 8, alignItems: "baseline", fontSize: 12,
                    background: "#fff", borderRadius: 8, padding: "6px 10px",
                    border: `1px solid ${isWorst ? m.border : LINE}`,
                  }}>
                    <span style={{ fontWeight: 800, color: m.color, whiteSpace: "nowrap" }}>{m.icon} {m.label}</span>
                    <span style={{ fontWeight: 700, color: INK, whiteSpace: "nowrap" }}>{p.label}</span>
                    <span style={{ color: MUTED }}>— {p.detail}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <button onClick={handleSubmit} disabled={saving} style={{
          width: "100%", background: PRIMARY, color: "#fff", border: "none",
          borderRadius: 10, padding: "14px", fontSize: 15, fontWeight: 800,
          boxShadow: "0 2px 8px rgba(37,99,235,0.25)",
          cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1,
        }}>
          {saving ? "กำลังบันทึก..." : "💾 บันทึกผลตรวจวัด"}
        </button>
      </Card>

      <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", margin: "20px 0 10px" }}>
        ประวัติการตรวจวัดล่าสุด
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {inspections.length === 0 && (
          <div style={{ textAlign: "center", color: "#94a3b8", padding: 20, fontSize: 13 }}>
            ยังไม่มีประวัติการตรวจวัด
          </div>
        )}
        {inspections.slice(0, 30).map(insp => {
          const st = insp.finalStatus || insp.overallStatus;
          const meta = st ? STATUS_META[st] : null;
          const condMeta = insp.conditionStatus && insp.conditionStatus !== "ok"
            ? STATUS_META[insp.conditionStatus] : null;
          return (
            <div key={insp.id} style={{
              background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12,
              padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
              borderLeft: `4px solid ${meta ? meta.color : LINE}`,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                  {insp.model} · {insp.partType} {insp.serialNo && `· SN: ${insp.serialNo}`}
                </div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>
                  {[
                    insp.values?.diameter != null && `Ø ${insp.values.diameter}`,
                    insp.values?.thickness != null && `หนา ${insp.values.thickness}`,
                    insp.gainAverage?.count ? `Gain ${insp.gainAverage.count} จุด` : null,
                  ].filter(Boolean).join(" · ")}
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                  👤 {insp.inspectedBy}{insp.createdAt ? ` · 🕒 ${formatDateTime(insp.createdAt)}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {meta && (
                  <div style={{
                    fontSize: 12, fontWeight: 800, color: meta.color, background: meta.bg,
                    border: `1px solid ${meta.border}`, borderRadius: 8, padding: "4px 10px",
                    whiteSpace: "nowrap",
                  }}>
                    {meta.icon} {meta.label}
                  </div>
                )}
                {condMeta && (
                  <div title="สภาพผิว" style={{
                    fontSize: 12, fontWeight: 800, color: condMeta.color, background: condMeta.bg,
                    border: `1px solid ${condMeta.border}`, borderRadius: 8, padding: "4px 10px",
                    whiteSpace: "nowrap",
                  }}>
                    👁 {condMeta.label}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- GAIN IMPORT (paste values) ---------------- */

// Accepts:
//  • one column of Y (pasted from Excel), or numbers separated by commas/spaces
//  • two columns X  Y per line (Excel copy gives a tab between them)
//  • lines with a label before ":"  e.g. "#1–#10 : 1.14, 1.16, …"
// Returns { points: [{x, y}], mode: "xy" | "y" } or { error }.
export function parseGainPaste(text) {
  const lines = String(text || "").split(/\r?\n/)
    .map(l => (l.includes(":") ? l.slice(l.lastIndexOf(":") + 1) : l))
    .map(l => l.replace(/#\S*/g, " "))
    .map(l => l.match(/-?\d+(?:\.\d+)?/g) || [])   // decimal point only; commas separate values
    .filter(nums => nums.length > 0);
  if (lines.length === 0) return { error: "ไม่พบตัวเลข" };
  const pairs = lines.length >= MIN_POINTS && lines.every(n => n.length === 2);
  const points = pairs
    ? lines.map(([x, y]) => ({ x, y }))
    : lines.flat().map(y => ({ x: "", y }));
  if (points.length < MIN_POINTS) return { error: `ต้องมีอย่างน้อย ${MIN_POINTS} ค่า (พบ ${points.length})` };
  if (points.length > MAX_POINTS) return { error: `ได้สูงสุด ${MAX_POINTS} จุด (พบ ${points.length})` };
  return { points, mode: pairs ? "xy" : "y" };
}

function GainImportPanel({ hasValues, onImport, onClose }) {
  const [text, setText] = useState("");
  const parsed = text.trim() ? parseGainPaste(text) : null;
  const apply = () => {
    if (!parsed || parsed.error) return;
    if (hasValues && !confirm(`แทนที่ค่า Gain ที่กรอกไว้ด้วย ${parsed.points.length} จุดที่วาง?`)) return;
    onImport(parsed.points);
    setText("");
  };
  return (
    <div style={{
      width: "100%", background: PRIMARY_LIGHT, border: `1px solid ${PRIMARY_BORDER}`,
      borderRadius: 10, padding: 10, marginBottom: 10, boxSizing: "border-box",
    }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: PRIMARY_DARK, marginBottom: 4 }}>📋 วางค่า Gain</div>
      <div style={{ fontSize: 11, color: "#475569", marginBottom: 6, lineHeight: 1.5 }}>
        คัดลอกจาก Excel หรือพิมพ์คั่นด้วยจุลภาค/เว้นวรรค/ขึ้นบรรทัดใหม่ เรียงจากขอบซ้ายไปขวา
        <br />• คอลัมน์เดียว = ค่า Y (X เว้นว่าง ใช้เลขลำดับจุด) • สองคอลัมน์ = X กับ Y
      </div>
      <textarea
        autoFocus value={text} onChange={e => setText(e.target.value)} rows={5}
        placeholder={"เช่น\n1.14, 1.21, 1.26, 1.28, 1.29\nหรือวางสองคอลัมน์ X  Y จาก Excel"}
        style={{
          width: "100%", boxSizing: "border-box", border: `1px solid ${PRIMARY_BORDER}`, borderRadius: 8,
          padding: 8, fontSize: 12, fontFamily: "ui-monospace, Menlo, Consolas, monospace", resize: "vertical",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: parsed?.error ? "#dc2626" : "#166534" }}>
          {!parsed ? "" : parsed.error ? `⚠️ ${parsed.error}`
            : `พบ ${parsed.points.length} จุด · ${parsed.mode === "xy" ? "X และ Y" : "Y อย่างเดียว"}`}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button type="button" onClick={() => { setText(""); onClose(); }} style={{
            background: "#fff", border: `1px solid ${LINE}`, color: "#475569", borderRadius: 7,
            padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
          }}>ยกเลิก</button>
          <button type="button" onClick={apply} disabled={!parsed || !!parsed.error} style={{
            background: !parsed || parsed.error ? "#cbd5e1" : PRIMARY, border: "none", color: "#fff",
            borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 800,
            cursor: !parsed || parsed.error ? "default" : "pointer", fontFamily: "inherit",
          }}>นำเข้า</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- LAYOUT HELPERS ---------------- */

const toolBtn = (disabled) => ({
  background: "#fff", color: disabled ? "#cbd5e1" : "#334155",
  border: `1px solid ${LINE}`, borderRadius: 7, padding: "4px 10px",
  fontSize: 11.5, fontWeight: 700, fontFamily: "inherit", cursor: disabled ? "default" : "pointer",
});

function Card({ children, dim }) {
  return (
    <div style={{
      background: "#fff", border: `1px solid ${LINE}`, borderRadius: 14, padding: 16,
      marginBottom: 14, boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
      opacity: dim ? 0.6 : 1, transition: "opacity .2s",
    }}>
      {children}
    </div>
  );
}

function SectionTitle({ step, title, hint, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      <span style={{
        width: 22, height: 22, borderRadius: 999, background: PRIMARY, color: "#fff",
        fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>{step}</span>
      <span style={{ fontSize: 14, fontWeight: 800, color: INK }}>{title}</span>
      {hint && <span style={{ fontSize: 11, color: "#94a3b8" }}>· {hint}</span>}
      {right && <div style={{ marginLeft: "auto" }}>{right}</div>}
    </div>
  );
}

/* ---------------- SHARED UI HELPERS ---------------- */

function FormLabel({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>{children}</div>;
}

const FormField = forwardRef(function FormField(
  { label, value, onChange, type = "text", placeholder, disabled, onFocus, onKeyDown }, ref
) {
  return (
    <div>
      <FormLabel>{label}</FormLabel>
      <input
        ref={ref}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%", border: `1px solid ${LINE}`, borderRadius: 8,
          padding: "10px 11px", fontSize: 14, fontFamily: "inherit", color: INK,
          boxSizing: "border-box", background: disabled ? "#f8fafc" : "#fff",
        }}
      />
    </div>
  );
});

const selectStyle = {
  width: "100%", border: "1px solid #e2e8f0", borderRadius: 8,
  padding: "10px", fontSize: 13, fontFamily: "inherit", background: "#fff",
  boxSizing: "border-box",
};

function smallBtnStyle(bg, color) {
  return {
    background: bg, color, border: "none", borderRadius: 6,
    padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  };
}

const modalOverlayStyle = {
  position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)",
  display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100,
};

const modalStyle = {
  background: "#fff", borderRadius: "16px 16px 0 0", padding: 20,
  width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
};
