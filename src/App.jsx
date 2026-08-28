import { useState, useEffect } from "react";
import PartPage from "./PartPage.jsx";

// No login system yet — this just captures a display name (kept in localStorage)
// so records still show who measured/edited what. Everyone currently gets full
// access to the standards tab since there's no way to distinguish roles without auth.
// Add real authentication later and pass a proper role through currentUser.role.
export default function App() {
  const [name, setName] = useState(() => localStorage.getItem("pcs_username") || "");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (name) localStorage.setItem("pcs_username", name);
  }, [name]);

  if (!name) {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#f8fafc", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        padding: 16,
      }}>
        <div style={{
          background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 28,
          width: "100%", maxWidth: 340, boxShadow: "0 4px 20px rgba(0,0,0,0.06)", boxSizing: "border-box",
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "linear-gradient(135deg,#F97316,#6B21A8)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontSize: 20, fontWeight: 800, marginBottom: 14,
          }}>⚙️</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginBottom: 4 }}>
            วัดขนาดล้อหุ่นยนต์
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16 }}>
            กรอกชื่อของคุณก่อนเริ่มใช้งาน ใช้บันทึกในประวัติการตรวจวัด
          </div>
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="ชื่อ-นามสกุล หรือชื่อเล่น"
            style={{
              width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px",
              fontSize: 14, boxSizing: "border-box", marginBottom: 12, fontFamily: "inherit",
            }}
            onKeyDown={e => { if (e.key === "Enter" && draft.trim()) setName(draft.trim()); }}
          />
          <button
            onClick={() => draft.trim() && setName(draft.trim())}
            style={{
              width: "100%", background: "#F97316", color: "#fff", border: "none",
              borderRadius: 8, padding: "10px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            เข้าใช้งาน
          </button>
        </div>
      </div>
    );
  }

  return <PartPage currentUser={{ name, role: "admin" }} />;
}
