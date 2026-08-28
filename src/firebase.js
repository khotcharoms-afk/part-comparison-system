import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// TODO: แทนที่ค่าด้านล่างด้วย Firebase config ของโปรเจกต์ใหม่
// (Firebase Console → Project settings → General → Your apps → SDK setup and configuration)
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
