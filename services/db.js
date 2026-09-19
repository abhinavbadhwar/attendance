/**
 * Shared Firestore connection. Both auth.js and firebase.js import getDb()
 * from here so admin.initializeApp() only ever runs once -- calling it twice
 * would throw an error.
 */
const admin = require('firebase-admin');
const path = require('path');

let db = null;

function getDb() {
  if (db) return db;

  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  } else {
    const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH || './firebase-service-account.json';
    // eslint-disable-next-line global-require, import/no-dynamic-require
    serviceAccount = require(path.resolve(process.cwd(), keyPath));
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
  return db;
}

module.exports = { getDb, admin };