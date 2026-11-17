# StoreWatch — PlayStation Store deal tracker

Finds **popular, high-priced PlayStation games that have dropped to a low price**.
Pick a region, then filter by original price, sale price, discount and popularity.
"Best deal first" ranks deep discounts on expensive, popular games at the top.

## Why the old version showed "HTTP 404"

The old page called `store.playstation.com/store/api/chihiro/...` straight from the browser.
That catalogue API has been retired (404), and the Store does not allow browser (CORS) requests anyway.
So a static page cannot work. This version adds a tiny Node server that fetches the data
and serves the site.

## Run locally

```
node server.js          # Node 18+, no npm install needed
# open http://localhost:8000
node test.js            # offline tests (mocked Store responses)
```

## Deploy on Render

This must be a **Web Service**, not a Static Site (the server is what talks to the Store).

1. In Render, delete or replace the current static site, then **New > Web Service** and pick this repo.
   (Or **New > Blueprint** and use `render.yaml`.)
2. Runtime: Node. Build command: leave empty (or `echo ok`). Start command: `node server.js`.
3. Deploy, then open `https://<your-service>.onrender.com/api/diagnose?region=IN`.

## If the page says it could not load deals

Open `/api/diagnose?region=IN`. It runs each data source once and shows the HTTP status or error.

| What you see | Meaning | Fix |
|---|---|---|
| graphql `GraphQL error: PersistedQueryNotFound` | Sony rotated the query hash | Set `PS_GRID_HASH` (see below). The server falls back to the category page meanwhile. |
| graphql and ssr both `HTTP 403` | The Store is blocking the host's IP range | Run the server from a different host/IP (home machine, another provider). |
| ssr `no __NEXT_DATA__ block` | Store page layout changed | Open an issue / adjust `fetchViaSsr` in `server.js`. |

**Getting a fresh hash:** open store.playstation.com > Deals in your browser, DevTools > Network,
filter `categoryGridRetrieve`, copy `sha256Hash` from the `extensions` query parameter, and set it
as the `PS_GRID_HASH` environment variable on Render.

## Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `PS_GRID_HASH` | built-in list | Persisted-query hash tried first |
| `PS_DEALS_CATEGORY_ID` | All Deals category | Store category to read |
| `PS_MAX_ITEMS` | 600 | Max deals scanned per refresh |
| `PORT` | 8000 | Set by Render automatically |

## Notes

- Results are cached for 5 minutes per region, and a forced refresh is limited to once per 30 seconds.
- On Render's free plan the service sleeps when idle; the first visit after a sleep takes a few seconds.
- Unofficial fan project, not affiliated with Sony Interactive Entertainment. It uses the same public
  data the Store website shows; Sony can change it at any time.
