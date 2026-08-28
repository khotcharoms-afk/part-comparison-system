import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAiDcb2G8b9OuhXy0fiIE7SfdKa0V9GG1U",
  authDomain: "part-comparison-system.firebaseapp.com",
  projectId: "part-comparison-system",
  storageBucket: "part-comparison-system.firebasestorage.app",
  messagingSenderId: "800195541618",
  appId: "1:800195541618:web:f9c89866f6d814f90020eb",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
