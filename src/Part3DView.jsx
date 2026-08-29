import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const STATUS_COLOR = {
  ok: "#16a34a",
  warning: "#d97706",
  critical: "#dc2626",
};
const IDLE_COLOR = "#cbd5e1";

function colorFor(status) {
  return STATUS_COLOR[status] || IDLE_COLOR;
}

const FIELD_KEYS = ["diameter", "thickness"];

const LEGEND_FIELDS = [
  { key: "diameter", label: "เส้นผ่านศูนย์กลาง" },
  { key: "thickness", label: "ความหนา" },
];

/**
 * Part3DView
 * - No modelUrl → renders a simplified generic "wheel" made of primitives. Works out of the box.
 * - modelUrl provided (.glb/.gltf) → loads the real model. Any mesh whose name contains
 *   "diameter" or "thickness" (case-insensitive) gets colored according to that field's status.
 *   Meshes that don't match either field keep their original look untouched.
 *   If loading fails, falls back to the primitive wheel automatically.
 */
export default function Part3DView({ results = {}, overallStatus, modelUrl }) {
  const mountRef = useRef(null);
  const fieldMatsRef = useRef(null); // { diameter:[mat,...], thickness:[...] }
  const bodyMatRef = useRef(null);   // only present in primitive fallback mode
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    const width = mount.clientWidth || 300;
    const height = mount.clientHeight || 260;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
    camera.position.set(3.4, 2.6, 4.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.5;
    controls.maxDistance = 10;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(5, 8, 5);
    scene.add(dirLight);

    const group = new THREE.Group();
    scene.add(group);

    const disposables = { geometries: [], materials: [] };
    fieldMatsRef.current = null;
    bodyMatRef.current = null;
    setLoadError(false);

    function buildPrimitiveFallback() {
      const bodyGeo = new THREE.CylinderGeometry(1.4, 1.4, 0.55, 48);
      const bodyMat = new THREE.MeshStandardMaterial({ color: IDLE_COLOR, roughness: 0.45, metalness: 0.1 });
      group.add(new THREE.Mesh(bodyGeo, bodyMat));

      const outerRingGeo = new THREE.TorusGeometry(1.4, 0.07, 16, 60);
      const outerRingMat = new THREE.MeshStandardMaterial({ color: IDLE_COLOR, roughness: 0.4 });
      const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
      outerRing.rotation.x = Math.PI / 2;
      group.add(outerRing);

      const rimGeo = new THREE.TorusGeometry(0.95, 0.06, 16, 60);
      const rimMat = new THREE.MeshStandardMaterial({ color: IDLE_COLOR, roughness: 0.4 });
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.29;
      group.add(rim);

      disposables.geometries.push(bodyGeo, outerRingGeo, rimGeo);
      disposables.materials.push(bodyMat, outerRingMat, rimMat);

      bodyMatRef.current = bodyMat;
      fieldMatsRef.current = {
        diameter: [outerRingMat], thickness: [rimMat],
      };
    }

    function bindRealModel(gltfScene) {
      const matched = { diameter: [], thickness: [] };
      gltfScene.traverse((child) => {
        if (!child.isMesh) return;
        const name = (child.name || "").toLowerCase();
        // clone material so we never mutate one shared across multiple meshes
        child.material = child.material.clone();
        disposables.materials.push(child.material);
        const key = FIELD_KEYS.find(k => name.includes(k.toLowerCase()));
        if (key) matched[key].push(child.material);
      });
      fieldMatsRef.current = matched;
      group.add(gltfScene);

      // Auto-fit camera/controls around the loaded model's actual size
      const box = new THREE.Box3().setFromObject(gltfScene);
      const size = box.getSize(new THREE.Vector3()).length() || 3;
      const center = box.getCenter(new THREE.Vector3());
      gltfScene.position.sub(center);
      const dist = size * 1.3;
      camera.position.set(dist * 0.7, dist * 0.55, dist * 0.85);
      camera.near = dist / 100;
      camera.far = dist * 20;
      camera.updateProjectionMatrix();
      controls.minDistance = dist * 0.3;
      controls.maxDistance = dist * 3;
    }

    if (modelUrl) {
      const loader = new GLTFLoader();
      loader.load(
        modelUrl,
        (gltf) => { if (!disposed) bindRealModel(gltf.scene); },
        undefined,
        (err) => {
          console.error("Part3DView: failed to load model", err);
          if (!disposed) { setLoadError(true); buildPrimitiveFallback(); }
        }
      );
    } else {
      buildPrimitiveFallback();
    }

    let raf;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      group.rotation.y += 0.0025;
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      renderer.dispose();
      disposables.geometries.forEach(g => g.dispose());
      disposables.materials.forEach(m => m.dispose());
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      fieldMatsRef.current = null;
      bodyMatRef.current = null;
    };
  }, [modelUrl]);

  // Update colors live as results/overallStatus change (no re-mount)
  useEffect(() => {
    const fieldMats = fieldMatsRef.current;
    if (!fieldMats) return;
    FIELD_KEYS.forEach(key => {
      const color = colorFor(results[key]?.status);
      (fieldMats[key] || []).forEach(mat => mat.color.set(color));
    });
    if (bodyMatRef.current) {
      bodyMatRef.current.color.set(overallStatus ? colorFor(overallStatus) : IDLE_COLOR);
    }
  }, [results, overallStatus]);

  return (
    <div>
      <div ref={mountRef} style={{
        width: "100%", height: 260, borderRadius: 12,
        background: "linear-gradient(180deg,#f8fafc,#f1f5f9)",
        border: "1px solid #e2e8f0", overflow: "hidden", cursor: "grab", touchAction: "none",
      }} />
      <div style={{ fontSize: 10, color: "#94a3b8", textAlign: "center", margin: "6px 0 10px" }}>
        {loadError
          ? "โหลดโมเดลจริงไม่สำเร็จ — แสดงแบบจำลองแทน · ลาก/หมุนดูได้"
          : "ลาก/หมุนดูโมเดลได้ · สีเปลี่ยนตามค่าที่วัด"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 10 }}>
        {LEGEND_FIELDS.map(f => {
          const r = results[f.key];
          const color = r?.status ? colorFor(r.status) : IDLE_COLOR;
          return (
            <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 6, color: "#64748b" }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
              <span>{f.label}{r?.diff != null ? ` (${r.diff.toFixed(1)}%)` : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
