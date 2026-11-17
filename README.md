# StoreWatch — PlayStation Store offer tracker

A responsive HTML/CSS/JavaScript page that searches popular PS4/PS5 game franchises, filters for discounted catalogue items, and refreshes every five minutes.

## Run it

Because browsers can restrict cross-origin requests, use a local static server rather than opening `index.html` directly:

```bash
cd ps_store_offers
python3 -m http.server 8000
```

Open http://localhost:8000

## Important API note

The frontend uses an **unofficial/public PlayStation Store catalogue endpoint**. Sony does not provide a stable, documented public API for this exact use case, and endpoint paths, response fields, CORS permissions, or rate limits may change. The code handles several common response shapes, but it may need adjustment if the Store changes its API.

If you see a CORS error, use a small same-origin proxy (for example a Node/Express or Python proxy) and change `searchStore()` in `app.js` to call that proxy. Do not put account credentials or private tokens in browser JavaScript.

## Features

- India is the default region; select another supported region from the header.
- Searches a list of popular game/franchise names.
- Shows discounted results, prices, cover art when supplied, and Store links.
- Search and sort the loaded results.
- Automatic refresh every five minutes, plus manual refresh.

## Notes

- The five-minute timer refreshes while the page is open. It does not run when the browser is closed or the device is asleep.
- Offers are region-specific and may require a PSN account or subscription to purchase.
- Unofficial fan project; not affiliated with Sony Interactive Entertainment.
