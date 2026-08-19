# Forge VR Asset Store

A storefront for VR-ready 3D asset packs. Creators sign in, upload packs of `.glb` files,
and browsers of the site pick through them by section, spin the meshes in the page, and
download what they want.

Its companion is the **Forge VR Asset Generator** desktop app, which publishes assets
straight from its library into this store over the API below.

```bash
npm install
npm start          # http://localhost:4173
sforge             # or: start it and open the browser in one go
```

## What it does

- **Accounts** — username + password, or Google sign-in when configured.
- **Packs** — a named group of `.glb` assets, filed under **Props**, **Characters** or
  **Custom**. One creator cannot own two packs with the same name; that rule is what lets
  the desktop app decide between "make a new pack" and "add to the one I already have".
- **Previews** — each asset can carry a PNG thumbnail. The creator picks up to seven of
  them to represent the pack on the catalogue.
- **Viewer** — the pack page renders the selected asset with three.js, served from this
  project's own `node_modules`. No CDN, no external calls.
- **Download** — a pack comes down as one `.zip` (stored, not deflated) with a
  `pack.json` manifest alongside the meshes.
- **Publishing keys** — the profile page issues API keys. Forge uses one as a bearer token.

### Limits

| Limit | Value | Why |
| --- | --- | --- |
| Asset file | 25 MB | A game-ready VR prop is a few hundred KB; a dense hero mesh a few MB. 25 MB is far past anything legitimate, close enough in to catch a raw scan or a stray Blender scene. |
| Pack total | 500 MB | |
| Assets per pack | 300 | |
| Preview PNG | 2 MB | |
| Cover assets | 7 | What fits on a catalogue plate. |

All of them are environment variables (`MAX_ASSET_BYTES`, `MAX_PACK_BYTES`,
`MAX_ASSETS_PER_PACK`, `MAX_THUMB_BYTES`) — see `server/config.js`.

Uploads are checked, not trusted: the first bytes of every file must be a glTF 2.0 binary
header whose declared length matches the payload, and previews must be real PNGs.

## The `sforge` command

`sforge` starts the store (if it is not already up) and opens it in the browser.

```bash
npm link           # once, to put sforge on your PATH
sforge             # open the catalogue
sforge profile     # open your packs
sforge sync        # push the local store up to the deployed backend
sforge --port 5000 # somewhere else
sforge --no-open   # just run the server
```

## Configuration

Everything is optional; the defaults run a local store with no setup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4173` / `127.0.0.1` | where to listen |
| `PUBLIC_URL` | `http://localhost:<port>` | public origin, used for OAuth redirects |
| `FORGE_STORE_STORAGE` | `./storage` | uploads + `db.json` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | enables Google sign-in |
| `GOOGLE_REDIRECT_URI` | `<PUBLIC_URL>/api/auth/google/callback` | must match the console entry |

### Google sign-in

1. In the Google Cloud console create an OAuth 2.0 **Web application** client.
2. Add `http://localhost:4173/api/auth/google/callback` as an authorised redirect URI.
3. Start the server with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set.

Without them the button is hidden and the sign-in page says so.

## Publishing from Forge

1. Sign in here, open **My packs**, and create a publishing key.
2. In Forge open **Store**, paste the store URL and the key, and press Connect.
3. Select assets in the library, choose *New pack* (or an existing one) and publish.

Forge sends one file per request: the `.glb` as the raw body, its metadata in headers.
The website's own uploader uses the same endpoint, so there is a single upload path.

## API

Authentication is either a session cookie (website) or `Authorization: Bearer <key>`
(desktop app). Both land on the same user.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/config` | limits, sections, whether Google is enabled |
| `POST` | `/api/auth/register` · `/api/auth/login` · `/api/auth/logout` | |
| `GET` | `/api/me` | the signed-in user |
| `GET`/`POST`/`DELETE` | `/api/keys[/:id]` | publishing keys (session only) |
| `GET` | `/api/packs?section=&q=&sort=` | public catalogue |
| `GET` | `/api/packs/:idOrSlug` | one pack with its assets |
| `GET` | `/api/me/packs` | your own packs |
| `POST` | `/api/packs` | create — `409` if you already have that name |
| `PATCH` | `/api/packs/:id` | name, section, description, `coverAssetIds` |
| `DELETE` | `/api/packs/:id` | pack and its files |
| `POST` | `/api/packs/:id/assets` | raw `.glb` body; `X-Asset-Name`, `X-Asset-Filename`, `X-Asset-Category`, `X-Asset-Triangles`, `X-Asset-Source-Id` |
| `POST` | `/api/packs/:id/assets/:assetId/thumb` | raw PNG body |
| `DELETE` | `/api/packs/:id/assets/:assetId` | |
| `GET` | `/api/packs/:id/download` | the pack as a `.zip` |
| `GET` | `/files/assets/:id.glb` · `/files/thumbs/:id.png` | the files themselves |

`X-Asset-Source-Id` is what makes re-publishing idempotent: an asset arriving with a
source id already present in the pack replaces it instead of adding a duplicate.

## Shape of the thing

```
server/    node:http server — no framework, no native modules
  config.js   limits and environment
  db.js       single-file JSON store, atomic writes
  auth.js     scrypt passwords, sessions, API keys, Google OAuth
  packs.js    packs, assets, validation
  zip.js      stored-mode ZIP writer
api/       Vercel serverless handler (same API, PostgreSQL + Blob)
schema.sql the Postgres schema for the Vercel deployment
vercel.json Vercel config (static public/ + functions)
public/    the site: plain HTML, CSS and ES modules
  vendor/three/  vendored three.js for the 3D viewer
storage/   local uploads and db.json (git-ignored)
test/      end-to-end API test
```

Data lives in `storage/db.json`; the meshes and previews sit next to it as files. That is
small enough not to need a database engine, and it keeps a clone of this repository free of
native build steps.

```bash
npm test    # boots a server on a temp directory and drives the whole API
```

## Deploying to Vercel

The local `server/` is a stateful Node process with a file database, which Vercel cannot
run (serverless, read-only filesystem). `api/[...path].js` is the same API backed by
PostgreSQL (Neon) and Vercel Blob, and `vercel.json` serves the static site in `public/`.

1. **Database** — create a Neon (or Vercel Postgres) database and run `schema.sql` once.
   Set the connection string as `DATABASE_URL`.
2. **Blob** — create a Vercel Blob store and set `BLOB_READ_WRITE_TOKEN`.
3. **Google (optional)** — set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and register
   `<your-domain>/api/auth/google/callback` as an authorised redirect URI. Leave unset to
   hide the button.
4. **Deploy** — `vercel` (or connect the repo in the dashboard). Optionally set
   `PUBLIC_URL` to your domain; when unset it is derived from each request.

Environment variables: `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `PUBLIC_URL`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the limit knobs from `server/config.js`.

Two differences from local:

- **Upload size** — Vercel functions cap request bodies at ~4.5 MB, so a single `.glb`
  larger than that cannot be uploaded through the Vercel API. Assets here are normally a
  few hundred KB; the 25 MB guard rail only fully applies to the local server.
- **File URLs** — assets and previews are served straight from Blob's public URLs instead
  of `/files/...`.

## Syncing local → deployed

Your local store and the Vercel deployment keep their data in two separate places — the
local one in `storage/db.json` + files on disk, the deployed one in Neon Postgres + Vercel
Blob. **Pushing code to GitHub moves source, not data**, so local uploads and accounts do
not reach the deployed site on their own. `sforge sync` (or `node bin/sync.js`) is the
bridge: it reads the local store and upserts the same users, packs, assets and API keys
into the database, and uploads any `.glb` / thumbnail files Blob does not already have. It
preserves ids and password hashes and is idempotent, so re-running it only pushes what
changed.

```bash
# one-time setup: put the Vercel credentials in .env (it is git-ignored)
DATABASE_URL=postgres://...
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...

sforge sync        # run it whenever you want the deployed site to match this machine
```

To make it automatic, install the pre-push hook (once, per clone):

```bash
cp scripts/pre-push .git/hooks/pre-push   # on Windows (Git Bash) also: chmod +x
```

With the hook in place, every `git push` runs the sync first. If the credentials are
missing the sync prints a note and the push goes ahead anyway, so it is safe to push code
without `.env` present.

## Licence

MIT.
