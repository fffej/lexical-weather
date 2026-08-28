# Lexical Weather

Lexical Weather is a zero-backend live dashboard that detects new and emerging
conversations on Bluesky. It compares short-term unigram and bigram activity with a
decaying historical baseline, embeds only lexically unusual posts, and clusters those
candidates into semantic topics entirely in the browser.

The static site is in [`docs/`](docs/) and is ready for GitHub Pages. It connects directly
to Bluesky's public Jetstream WebSocket; no Bluesky login, application server, database,
or build step is needed.

## Run the dashboard locally

Requirements: Node 22.15 or newer (Node 24 is configured in `.nvmrc`) and Python 3 for
the convenience static server.

```sh
npm install
npm test
npm run build
npm run dashboard
```

Then open <http://localhost:4173>. Serving the directory also mirrors the GitHub Pages
deployment more closely than opening `docs/index.html` directly. The first semantic
candidate downloads a quantized `all-MiniLM-L6-v2` model; the browser caches it for
later visits.

## Deploy to GitHub Pages

The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) deploys
`docs/` whenever `main` is pushed. In the repository settings, choose **GitHub Actions**
as the Pages source. A manual run is also available from the Actions tab.

The deployed page is intentionally serverless. Detector state exists only in the open
tab, so refreshing starts with an empty baseline. Counters decay lazily; lexical
features, duplicate signatures, active topics, recent sources, representative samples,
and the embedding queue all have hard bounds. On disconnect, the client retries with
exponential backoff, alternates between the east and west public Jetstream instances,
and resumes from its last sequence cursor.

## Measurement

- Only `app.bsky.feed.post` commits are requested upstream. English-tagged and unlabelled
  posts are analyzed; explicitly non-English posts are skipped because the embedding
  model is English-oriented.
- Text is NFKC-normalized, lowercased, stripped to useful tokens, and converted into
  unique unigrams and adjacent bigrams. URLs and mentions become fixed tokens and do not
  act as standalone signals.
- Fast (one minute), medium (ten minute), and slow (six hour) exponentially decaying
  counts determine lexical novelty. A one-message anomaly does not cross the evidence
  threshold, and stable activity converges toward a low burst score.
- Exact repeats are suppressed for three minutes. Candidate embeddings run in a Web
  Worker so model loading and inference do not block the live UI. The queue is capped at
  100 candidates during startup or overload.
- Unit-normalized embeddings join an active centroid at cosine similarity 0.72 or create
  a new topic. Centroids, temporal activity, coherence, source diversity, source
  throttling, and five representative samples update online.
- At most 20 eligible topics are shown. Each requires three candidate messages and, when
  source identity is present, two sources. Ranking exposes burst, volume, coherence,
  novelty, and diversity rather than hiding them in an opaque score.
- This is an approximate detector with a cold-start baseline, not a complete archive or
  a statement about all Bluesky activity. Defaults are centralized in
  [`TrendDetectionDefaults`](docs/trends.js) for tuning.

## Topic collector

A small, restart-safe collector for Bluesky's full-network Jetstream. It listens only to
`app.bsky.feed.post` records, matches configured topics in post text, and stores current
matching posts in SQLite.

## Quick start

```sh
cd /home/fffej/code/bluesky
npm install
cp .env.example .env
npm test
npm run build
npm run collect
```

The default topic is `database`. Stop with Ctrl-C; the cursor is committed in the same
SQLite transaction as each post change, so the next run resumes without a gap. Live
Jetstream access is public and needs no Bluesky login.

Useful commands:

```sh
npm run dev                         # restart automatically after source edits
npm run list -- --limit 50          # inspect recent matches
npm run list -- --json              # newline-delimited JSON for scripts
npm run stats                       # post count and stream cursor
npm run collect -- --max-matches 1  # convenient live smoke test
sqlite3 data/posts.sqlite           # query the database directly
```

Set multiple comma-separated fragments in `.env`, for example:

```dotenv
TOPICS=database,postgres,sql server
```

Matching is case-insensitive substring matching, so `database` includes both `database`
and `databases`. Only post text is searched; author profiles and linked-page content are
not.

## Historical replay

Live collection starts at the current network tip. To backfill the archive and then move
seamlessly into live collection, create a Jetstream key at <https://bsky.network/account>,
put it in `.env`, and run:

```sh
npm run collect -- --replay
```

With a new database, replay starts at the beginning of the available archive and can be
very large. On subsequent runs it resumes from the stored cursor. Bluesky meters archive
downloads; live collection remains unmetered.

## Data behavior

The `posts` table is keyed by AT URI, making reconnect delivery idempotent. Post updates
replace the row. Post deletes, account deletes, and repository sync-divergence markers
remove affected content, keeping the database aligned with current network state. The
original decoded record is retained in `raw_record` for later analysis.
