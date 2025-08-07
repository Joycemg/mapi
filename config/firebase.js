// config/firebase.js

const firebaseConfig = {
    apiKey: "AIzaSyCP1VddmMF11_QwZGMx6ILHbOpSVhYIMk4",
    authDomain: "mapaj-6017a.firebaseapp.com",
    projectId: "mapaj-6017a",
    storageBucket: "mapaj-6017a.firebasestorage.app",
    messagingSenderId: "411493901671",
    appId: "1:411493901671:web:5e732ecacbb43226a4fbc2"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const charactersRef = db.collection("characters");
