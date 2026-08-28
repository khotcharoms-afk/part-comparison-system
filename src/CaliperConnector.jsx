import { useRef, useState, useCallback } from "react";

const BAUD_OPTIONS = [2400, 4800, 9600, 19200];

/**
 * CaliperConnector
 * Connects to a USB digital caliper via the Web Serial API (Chrome/Edge on desktop only —
 * Safari/Firefox and iOS/iPadOS do not support this API).
 *
 * Most "USB data output" digital caliper cables stream a line of text each time the
 * caliper's DATA/hold button is pressed, e.g. "12.34mm\r\n" or "-0.05\r\n". This parses
 * the first signed decimal number found in each line and reports it via onValue.
 *
 * NOTE: exact output format varies by cable/caliper brand/baud rate. Use "ดู raw log"
 * to see what's actually coming through — the parser may need a small tweak once real
 * hardware is connected (adjust baud rate dropdown, or the regex in parseNumber below).
 */
export default function CaliperConnector({ onValue, disabled }) {
  const [supported] = useState(() => typeof navigator !== "undefined" && "serial" in navigator);
  const [connected, setConnected] = useState(false);
  const [baud, setBaud] = useState(4800);
  const [rawLog, setRawLog] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const portRef = useRef(null);
  const readerRef = useRef(null);
  const keepReadingRef = useRef(false);

  const appendLog = (line) => setRawLog(prev => [...prev.slice(-9), line]);

  const parseNumber = (line) => {
    const cleaned = line.trim();
    if (!cleaned) return null;
    const match = cleaned.match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    const num = parseFloat(match[0]);
    return isNaN(num) ? null : num;
  };

  const connect = useCallback(async () => {
    if (!supported) return;
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: baud });
      portRef.current = port;
      setConnected(true);
      keepReadingRef.current = true;

      const textDecoder = new TextDecoderStream();
      const readableClosed = port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      readerRef.current = { reader, readableClosed };

      let buffer = "";
      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          let idx;
          while ((idx = buffer.search(/[\r\n]/)) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.trim()) {
              appendLog(line.trim());
              const num = parseNumber(line);
              if (num !== null) onValue?.(num);
            }
          }
        }
      }
    } catch (e) {
      console.error("Caliper connect error:", e);
      appendLog("⚠️ เชื่อมต่อไม่สำเร็จ: " + e.message);
      setConnected(false);
    }
  }, [supported, baud, onValue]);

  const disconnect = useCallback(async () => {
    keepReadingRef.current = false;
    try {
      if (readerRef.current?.reader) await readerRef.current.reader.cancel();
      if (portRef.current) await portRef.current.close();
    } catch (e) {
      console.error("Caliper disconnect error:", e);
    }
    portRef.current = null;
    readerRef.current = null;
    setConnected(false);
  }, []);

  if (!supported) {
    return (
      <div style={{
        background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10,
        padding: 12, fontSize: 11, color: "#92400e", marginBottom: 12,
      }}>
        ⚠️ เบราว์เซอร์นี้ไม่รองรับการเชื่อมต่อคาลิปเปอร์โดยตรง — ใช้ Chrome หรือ Edge บนคอมพิวเตอร์
      </div>
    );
  }

  return (
    <div style={{
      background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, marginBottom: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>📏 คาลิปเปอร์</span>

        {!connected ? (
          <>
            <select value={baud} onChange={e => setBaud(Number(e.target.value))} style={{
              border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 6px", fontSize: 11, fontFamily: "inherit",
            }}>
              {BAUD_OPTIONS.map(b => <option key={b} value={b}>{b} baud</option>)}
            </select>
            <button onClick={connect} disabled={disabled} style={{
              background: "#F97316", color: "#fff", border: "none", borderRadius: 6,
              padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              opacity: disabled ? 0.5 : 1,
            }}>🔌 เชื่อมต่อ</button>
          </>
        ) : (
          <>
            <span style={{
              fontSize: 11, fontWeight: 700, color: "#16a34a", background: "#f0fdf4",
              border: "1px solid #bbf7d0", borderRadius: 6, padding: "4px 10px",
            }}>● เชื่อมต่อแล้ว</span>
            <button onClick={disconnect} style={{
              background: "#f1f5f9", color: "#475569", border: "none", borderRadius: 6,
              padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
            }}>ตัดการเชื่อมต่อ</button>
          </>
        )}

        <button onClick={() => setShowLog(v => !v)} style={{
          background: "none", border: "none", color: "#94a3b8", fontSize: 11,
          cursor: "pointer", fontFamily: "inherit", marginLeft: "auto",
        }}>{showLog ? "ซ่อน log" : "ดู raw log"}</button>
      </div>

      {connected && (
        <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 8 }}>
          คลิกเลือกช่องที่ต้องการวัด แล้วกดปุ่มส่งค่าที่ตัวคาลิปเปอร์ — ค่าจะเติมลงช่องที่เลือกและเลื่อนไปช่องถัดไปอัตโนมัติ
        </div>
      )}

      {showLog && (
        <div style={{
          marginTop: 8, background: "#0f172a", borderRadius: 6, padding: 8,
          fontFamily: "monospace", fontSize: 10, color: "#a3e635", maxHeight: 100, overflowY: "auto",
        }}>
          {rawLog.length === 0
            ? <div style={{ color: "#64748b" }}>ยังไม่มีข้อมูลเข้ามา...</div>
            : rawLog.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
