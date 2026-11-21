# EduFuture — free deployment guide

This branch uses Firebase Spark for static hosting, Firebase Authentication and Firestore, with the Express API hosted separately on Render's Free web service.

## 1. Create the Render API

1. Open https://render.com and sign in with GitHub.
2. Choose **New → Blueprint** and select `faijraja786/U.-H.-S.-Rakasiya`.
3. Select branch `feature/complete-dashboards`; Render reads the root `render.yaml`.
4. When prompted for environment variables, set:
   - `BOOTSTRAP_ADMIN_EMAIL` = the intended first Super Admin email.
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = the complete service-account JSON downloaded from Firebase Console → Project settings → Service accounts → Generate new private key.
5. Keep the service-account JSON private. Never commit it, paste it into chat, or put it in frontend files.
6. Create the service and wait until its deploy is Live. Test `https://YOUR-SERVICE.onrender.com/health`; it should return JSON with `ok: true`.

Render Free services can sleep when idle and may take time to wake. This is a free-tier limitation.

## 2. Set the API URL in the frontend

Replace the placeholder `API_BASE` in `public/firebase-config.js` with the exact Render URL, without a trailing slash. Commit that one-line change to `feature/complete-dashboards`.

## 3. Firebase setup and Hosting

1. In Firebase Console, enable Email/Password and Google sign-in under Authentication → Sign-in method.
2. Add `edufuture-1c3dd.web.app` and `edufuture-1c3dd.firebaseapp.com` as authorized domains if they are not already listed.
3. Confirm Firestore Database exists in the project.
4. In Cloud Shell, pull the latest branch and run `firebase deploy --only hosting,firestore:rules`. This deliberately does not deploy Cloud Functions and does not require Blaze for Firebase Hosting/Firestore rules.

## 4. First Super Admin

After the site and API are live, create/login with the configured Super Admin email and choose **Super Admin Login** once. The backend only bootstraps the first Super Admin when the configured email matches and the one-time bootstrap lock is unused.

## Important

- Do not deploy `functions/` to Firebase; it now contains the Render Express API.
- Keep the service-account JSON only in Render environment variables.
- Firebase client config in `public/firebase-config.js` is public client configuration, not an Admin credential.
- Render Free is suitable for testing/demo use, not guaranteed always-on production service.
