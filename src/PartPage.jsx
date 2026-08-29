import { useState, useEffect, useMemo, useRef, forwardRef } from "react";
import {
  collection, addDoc, onSnapshot, query, orderBy,
  doc, updateDoc, deleteDoc, serverTimestamp
} from "firebase/firestore";
import { db } from "./firebase";
import Part3DView from "./Part3DView.jsx";
import CaliperConnector from "./CaliperConnector.jsx";

const ORANGE = "#F97316";
const PURPLE = "#6B21A8";
const ORANGE_LIGHT = "#FFF7ED";
const ORANGE_BORDER = "#FED7AA";

const FIELDS = [
  { key: "diameter", label: "เส้นผ่านศูนย์กลาง (mm)" },
  { key: "thickness", label: "ความหนา (mm)" },
];

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

export default function PartPage({ currentUser, onBack, isMobile }) {
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
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      {/* Header */}
      <div style={{
        background: "#fff", borderBottom: "1px solid #e2e8f0",
        padding: "14px 16px", display: "flex", alignItems: "center", gap: 12,
        position: "sticky", top: 0, zIndex: 40,
      }}>
        {onBack && (
          <button onClick={onBack} style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 18, color: "#475569", padding: 4,
          }}>←</button>
        )}
        <div style={{
          width: 34, height: 34, borderRadius: 9,
          background: `linear-gradient(135deg, ${ORANGE}, ${PURPLE})`,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontSize: 15, fontWeight: 800,
        }}>⚙️</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>วัดขนาดล้อหุ่นยนต์</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>Part Standards Comparison</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: "flex", gap: 8, padding: "12px 16px 0", background: "#fff",
        borderBottom: "1px solid #e2e8f0",
      }}>
        <TabButton active={tab === "inspect"} onClick={() => setTab("inspect")}>
          📋 บันทึกค่าตรวจวัด
        </TabButton>
        <TabButton active={tab === "standards"} onClick={() => setTab("standards")}>
          📐 ค่ามาตรฐาน
        </TabButton>
      </div>

      <div style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>
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
      background: "none", border: "none", cursor: "pointer",
      padding: "10px 4px", fontSize: 13, fontWeight: 700,
      color: active ? ORANGE : "#94a3b8",
      borderBottom: active ? `2px solid ${ORANGE}` : "2px solid transparent",
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

function StandardsTab({ standards, canManage, currentUser }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyStandardForm);
  const [saving, setSaving] = useState(false);

  const openNew = () => {
    setForm(emptyStandardForm);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (s) => {
    setForm({
      model: s.model || "",
      partType: s.partType || "",
      diameter: s.specs?.diameter ?? "",
      thickness: s.specs?.thickness ?? "",
      warning: s.thresholds?.warning ?? 5,
      critical: s.thresholds?.critical ?? 10,
      modelUrl: s.modelUrl || "",
    });
    setEditingId(s.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.model.trim() || !form.partType.trim()) {
      alert("กรุณากรอกรุ่นและประเภทอะไหล่");
      return;
    }
    setSaving(true);
    const payload = {
      model: form.model.trim(),
      partType: form.partType.trim(),
      specs: {
        diameter: parseFloat(form.diameter) || 0,
        thickness: parseFloat(form.thickness) || 0,
      },
      thresholds: {
        warning: parseFloat(form.warning) || 5,
        critical: parseFloat(form.critical) || 10,
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
    await deleteDoc(doc(db, "partStandards", id));
  };

  return (
    <div>
      {canManage && (
        <button onClick={openNew} style={{
          width: "100%", background: ORANGE, color: "#fff", border: "none",
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
            background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14,
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
                  background: ORANGE_LIGHT, border: `1px solid ${ORANGE_BORDER}`,
                  borderRadius: 8, padding: "6px 8px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 9, color: "#c2410c", fontWeight: 600 }}>{f.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#7c2d12" }}>{s.specs?.[f.key]}</div>
                </div>
              ))}
            </div>
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
                flex: 1, background: ORANGE, border: "none", color: "#fff",
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

function InspectTab({ standards, inspections, currentUser }) {
  const [selectedId, setSelectedId] = useState("");
  const [serialNo, setSerialNo] = useState("");
  const [values, setValues] = useState({ diameter: "", thickness: "" });
  const [saving, setSaving] = useState(false);
  const [activeField, setActiveField] = useState(FIELDS[0].key);
  const fieldRefs = useRef({});
  const [condition, setCondition] = useState(emptyCondition);
  const [conditionNote, setConditionNote] = useState("");

  const selected = standards.find(s => s.id === selectedId);

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

  const resetForm = () => {
    setSerialNo("");
    setValues({ diameter: "", thickness: "" });
    setActiveField(FIELDS[0].key);
    setCondition(emptyCondition);
    setConditionNote("");
  };

  const handleCaliperValue = (num) => {
    if (!selected) return;
    setValues(prev => ({ ...prev, [activeField]: String(num) }));
    const idx = FIELDS.findIndex(f => f.key === activeField);
    const next = FIELDS[(idx + 1) % FIELDS.length];
    setActiveField(next.key);
    requestAnimationFrame(() => fieldRefs.current[next.key]?.focus());
  };

  const handleSubmit = async () => {
    if (!selected) { alert("กรุณาเลือกรุ่น/ประเภทอะไหล่"); return; }
    const anyFilled = Object.values(values).some(v => v !== "");
    const anyConditionChecked = CONDITION_ITEMS.some(c => condition[c.key]);
    if (!anyFilled && !anyConditionChecked) { alert("กรุณากรอกค่าที่วัด หรือติ๊กสภาพผิวอย่างน้อย 1 อย่าง"); return; }

    setSaving(true);
    try {
      await addDoc(collection(db, "partInspections"), {
        model: selected.model,
        partType: selected.partType,
        standardId: selected.id,
        serialNo: serialNo.trim(),
        values: {
          diameter: parseFloat(values.diameter) || null,
          thickness: parseFloat(values.thickness) || null,
        },
        results: liveResults,
        overallStatus,
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
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <FormLabel>เลือกรุ่น / ประเภทอะไหล่</FormLabel>
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
              margin: "12px 0", padding: 10, background: "#f8fafc", borderRadius: 8,
            }}>
              {FIELDS.map(f => (
                <div key={f.key} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#94a3b8" }}>{f.label}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>{selected.specs?.[f.key]}</div>
                </div>
              ))}
            </div>

            <Part3DView results={liveResults} overallStatus={overallStatus} modelUrl={selected.modelUrl || undefined} />
          </>
        )}

        <div style={{ marginTop: 14 }}>
          <FormField label="Serial No." value={serialNo} onChange={setSerialNo} />
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", margin: "16px 0 8px" }}>
          ค่าที่วัดได้
        </div>

        <CaliperConnector onValue={handleCaliperValue} disabled={!selected} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {FIELDS.map(f => {
            const r = liveResults[f.key];
            const meta = r?.status ? STATUS_META[r.status] : null;
            const isActive = activeField === f.key;
            return (
              <div key={f.key} style={{
                borderRadius: 10, padding: isActive ? 4 : 0,
                boxShadow: isActive ? "0 0 0 2px #F97316" : "none",
              }}>
                <FormField
                  ref={el => (fieldRefs.current[f.key] = el)}
                  label={f.label} type="number" value={values[f.key]}
                  onChange={v => setValues({ ...values, [f.key]: v })}
                  onFocus={() => setActiveField(f.key)}
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


        <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", margin: "18px 0 8px" }}>
          สภาพผิวหน้ายาง (ตรวจด้วยสายตา — ไม่ต้องใช้เครื่องมือ)
        </div>
        <div style={{
          display: "grid", gridTemplateColumns: isMobileGrid(), gap: 8,
          background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 12,
        }}>
          {CONDITION_ITEMS.map(c => (
            <label key={c.key} style={{
              display: "flex", alignItems: "center", gap: 8, fontSize: 13,
              color: condition[c.key] ? "#0f172a" : "#475569", cursor: "pointer",
              fontWeight: condition[c.key] ? 700 : 500,
            }}>
              <input
                type="checkbox"
                checked={condition[c.key]}
                disabled={!selected}
                onChange={e => setCondition({ ...condition, [c.key]: e.target.checked })}
                style={{ width: 16, height: 16, accentColor: c.severity === "critical" ? "#dc2626" : "#d97706" }}
              />
              {c.label}
            </label>
          ))}
        </div>
        <div style={{ marginTop: 8 }}>
          <FormField
            label="หมายเหตุเพิ่มเติม (ถ้ามี)" value={conditionNote}
            onChange={setConditionNote} disabled={!selected}
            placeholder="เช่น ตำแหน่งที่พบ, ความรุนแรง"
          />
        </div>
        {CONDITION_ITEMS.some(c => condition[c.key]) && (
          <div style={{
            marginTop: 8, padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 700,
            background: STATUS_META[conditionStatus].bg,
            border: `1px solid ${STATUS_META[conditionStatus].border}`,
            color: STATUS_META[conditionStatus].color,
          }}>
            {STATUS_META[conditionStatus].icon} สภาพผิว: {STATUS_META[conditionStatus].label}
          </div>
        )}

        {overallStatus && (
          <div style={{
            marginTop: 16, padding: 12, borderRadius: 10, textAlign: "center",
            background: STATUS_META[overallStatus].bg,
            border: `1px solid ${STATUS_META[overallStatus].border}`,
            color: STATUS_META[overallStatus].color, fontWeight: 800, fontSize: 14,
          }}>
            {STATUS_META[overallStatus].icon} ผลรวม: {STATUS_META[overallStatus].label}
          </div>
        )}

        <button onClick={handleSubmit} disabled={saving} style={{
          width: "100%", marginTop: 16, background: PURPLE, color: "#fff", border: "none",
          borderRadius: 10, padding: "13px", fontSize: 14, fontWeight: 700,
          cursor: "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1,
        }}>
          {saving ? "กำลังบันทึก..." : "บันทึกผลตรวจวัด"}
        </button>
      </div>

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
          const meta = insp.overallStatus ? STATUS_META[insp.overallStatus] : null;
          const condMeta = insp.conditionStatus && insp.conditionStatus !== "ok"
            ? STATUS_META[insp.conditionStatus] : null;
          return (
            <div key={insp.id} style={{
              background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10,
              padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                  {insp.model} · {insp.partType} {insp.serialNo && `· SN: ${insp.serialNo}`}
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                  {insp.inspectedBy}
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

function isMobileGrid() {
  return typeof window !== "undefined" && window.innerWidth < 500 ? "1fr" : "1fr 1fr 1fr";
}

/* ---------------- SHARED UI HELPERS ---------------- */

function FormLabel({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>{children}</div>;
}

const FormField = forwardRef(function FormField(
  { label, value, onChange, type = "text", placeholder, disabled, onFocus }, ref
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
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%", border: "1px solid #e2e8f0", borderRadius: 8,
          padding: "9px 10px", fontSize: 13, fontFamily: "inherit",
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
  width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto",
};
