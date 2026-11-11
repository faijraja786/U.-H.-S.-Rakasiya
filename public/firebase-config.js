// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDRMZV_3Auq34ZrMIw4MY4e5Y9JDhTlF3E",
  authDomain: "edufuture-1c3dd.firebaseapp.com",
  projectId: "edufuture-1c3dd",
  storageBucket: "edufuture-1c3dd.firebasestorage.app",
  messagingSenderId: "551153142653",
  appId: "1:551153142653:web:ebe9c769bc7e8c874f9a14",
  measurementId: "G-E498Q64F3Q"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
