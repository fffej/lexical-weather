# Lexical Weather

Lexical Weather is a zero-backend live dashboard that shows which people, places,
organizations, and things are being discussed on Bluesky. It uses the rule-based
[Compromise](https://github.com/spencermountain/compromise) NLP library to extract
entities and common noun phrases entirely in the browser.

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
deployment more closely than opening `docs/index.html` directly.

## Deploy to GitHub Pages

The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) deploys
`docs/` whenever `main` is pushed. In the repository settings, choose **GitHub Actions**
as the Pages source. A manual run is also available from the Actions tab.

The deployed page is intentionally serverless. Its entity dictionary exists only in the
open tab, so refreshing starts a new live sample. Entity observations expire precisely
at the selected window boundary, and a 10,000-entity least-recently-used cap provides a
hard bound. Full post bodies are kept separately in a 250-item recent sample only for
the drill-down. Personal exclusions are stored in the browser and can be inspected or
restored from the stop-list panel. On disconnect, the client retries with exponential
backoff, alternates between the east and west public Jetstream instances, and resumes
from its last sequence cursor.

## Measurement

- Only `app.bsky.feed.post` create/update/delete events are requested upstream. The first
  create or update seen for a post adds entity observations; later updates do not count
  as another distinct post. Deletes remove it from the recent drill-down but do not
  revise aggregate observations.
- URLs are discarded before Compromise analyzes the original-cased text. People, places,
  and organizations are named entities; “things” are common noun phrases. Descriptive
  words are retained only when they modify a noun rather than appearing alone.
- Each entity is counted at most once per post for ranking. A secondary mention count
  retains repeated references within the same post.
- The “What’s hot” list contains at most 50 entities, ranked by distinct post count,
  then total mentions and recency. A candidate must appear in at least three posts.
- English-tagged and unlabelled posts are included. Explicitly non-English posts are
  skipped because the bundled Compromise analysis is English-specific.
- Short fragments, repeated-letter noise, function words, conversational filler, link
  fragments, and common profanity are suppressed. User-ignored phrases remain tracked
  so restoring one can reveal it immediately.
- Compromise is a fast heuristic tagger rather than a neural model. Social text and names
  without enough context can be misclassified; the dashboard describes a sample, not the
  whole population.

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
