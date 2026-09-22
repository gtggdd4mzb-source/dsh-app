# DSH PWA

This is the browser version of DSH for iPhone users who do not have access to Xcode. It is a static PWA: host these files on GitHub Pages, Netlify, Vercel, or any HTTPS static host, then open the URL in Safari and choose **Share > Add to Home Screen**.

It includes Home, Sessions, Activity, local persistence, new sessions, and interactive session messages. It does not require a backend.

## Deploy on GitHub Pages

1. Push these files to the root of a repository (branch `main`).
2. Open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`, **Branch** to `main`, folder `/ (root)`, then **Save**.
4. Wait for the deployment to finish, then open `https://<user>.github.io/<repo>/` — the address is also shown at the top of the Pages settings.

## Install on iPhone

1. Open the Pages URL in **Safari** (not Chrome).
2. Tap **Share → Add to Home Screen**.
3. Launch it from the home screen. It opens full-screen without Safari chrome and works offline.

`apple-touch-icon.png` (180×180 PNG) supplies the home-screen icon: iOS ignores SVG icons, so keep the PNG even though `icon.svg` is still shipped for desktop browsers.

