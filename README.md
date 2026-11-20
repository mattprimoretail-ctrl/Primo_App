# Primo Cannabis app (installable)

An installable web app (PWA). Customers open one link, tap "Install" or "Add to Home Screen", and Primo shows up as an icon on their phone or desktop.

## What is in this folder
- `index.html` the whole app
- `manifest.webmanifest`, `sw.js`, `icons/`, `favicon.ico` what makes it installable and work offline
- `netlify/functions/alpine.js` the small server piece that talks to Alpine IQ and keeps your API key secret
- `netlify.toml` hosting settings

## Where it has to live
The app and its server piece must be on the same host. Webflow cannot run the server piece or a service worker, so:
1. Put this folder in a GitHub repo.
2. Create a free Netlify account, choose "Import from Git", pick the repo. No build command. Publish directory `.`
3. In Netlify, Domain settings, add `app.primostores.com`. Add the CNAME record Netlify shows you wherever primostores.com's DNS is managed.
4. On Webflow, add a button "Get the Primo app" linking to `https://app.primostores.com`. That is the "download" page for customers.

(Cloudflare Pages or Vercel also work, but the function file would need small changes.)

## Alpine IQ setup (do not put the key in any file)
In Netlify, Site settings, Environment variables, add:
- `ALPINE_API_KEY` your Alpine API key
- `ALPINE_USER_ID` 3882
- `TOKEN_SECRET` any long random string (30+ characters)
- `DIAG_TOKEN` any other random string (used once below)

**Rotate your API key.** It was pasted in a chat, so treat it as exposed. Generate a new one in Alpine and use that in Netlify.

## Confirm the Alpine paths (important, not yet tested)
The function was written from Alpine's help articles and could not be run against Alpine from where it was built. Sign-in is: text a 4-digit code to the member's phone, then read their wallet. Test it once:

1. Deploy, then run this in a terminal (use your test member's phone and the code Alpine texts you after requesting one in the app):
   `curl -X POST https://app.primostores.com/api/alpine -H "Content-Type: application/json" -d '{"action":"diag","phone":"PHONE10DIGITS","code":"1234","token":"YOUR_DIAG_TOKEN"}'`
2. It shows the shape of Alpine's reply (field names only, no personal values) and which of points, lifetime, redeemed, purchases and joined it found.
3. If the status is 404 or 401, check the endpoint paths and auth style in lab.alpineiq.com/swagger and set the optional variables listed at the top of `netlify/functions/alpine.js` (`ALPINE_VERIFY_URL`, `ALPINE_VIEW_URL`, `ALPINE_REFRESH_URL`, `ALPINE_AUTH`, `ALPINE_PHONE_FORMAT`). No code edits needed.
4. If a field is not found, that stat and its badges are hidden for signed-in members instead of showing a fake 0. Send me the shape output and I will map it.

Known unknowns: the Refresh button uses a lookup endpoint that may need changing; if it fails, the app asks the member to sign in again. "Full limit" badges cannot come from Alpine and stay locked until there is a source for them.

## Updating the app
Edit files, commit to GitHub, Netlify redeploys. If you change app files, change `VERSION` in `sw.js` so phones pick up the new version.
