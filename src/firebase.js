import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// TODO: แทนที่ค่าด้านล่างด้วย Firebase config ของโปรเจกต์ใหม่
// (Firebase Console → Project settings → General → Your apps → SDK setup and configuration)
const firebaseConfig = {
  apiKey: "// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAiDcb2G8b9OuhXy0fiIE7SfdKa0V9GG1U",
  authDomain: "part-comparison-system.firebaseapp.com",
  projectId: "part-comparison-system",
  storageBucket: "part-comparison-system.firebasestorage.app",
  messagingSenderId: "800195541618",
  appId: "1:800195541618:web:f9c89866f6d814f90020eb",
  measurementId: "G-M4H5XTKXG9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
