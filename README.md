# movie-redirects

> **[Clusterflick](https://clusterflick.com)** is a free, open-source site
> listing every film showing in London, from 450+ venues in one search.
>
> This repository is the Cloudflare Worker in front of the site's film pages,
> `clusterflick.com/movies/*`. See the
> [Clusterflick organisation](https://github.com/clusterflick) for how the
> pieces fit together.

A Cloudflare Worker that answers a dead film URL with a redirect, when there's
somewhere better to send it than a 404.

A film page lives at `/movies/<id>/<slug>/`, and both halves move. The slug
follows the film's title, which TheMovieDB and venues edit. A listing nothing
matched is keyed by a hash of the venue's title, so it gets a new id when the
venue retitles it or when it's matched to a film. Every one of those leaves
behind a URL that someone bookmarked, shared or Google indexed. The site is a
static export on GitHub Pages, which can't redirect, and a redirect made by
JavaScript on the 404 page comes too late for a search engine, which has
already seen the 404.

## What it does

Every request under `/movies/` goes through to GitHub Pages. Only a 404 from
the site is looked at; a page that exists, and the site's own redirects, are
passed back exactly as they came. A 404 is checked against the site's map of
film URLs (see [The map](#the-map)), in this order:

| The 404                                           | Response                     |
| ------------------------------------------------- | ---------------------------- |
| A known id under the wrong slug, or none          | 301 to the film's page       |
| The old id of a listing since matched to a film   | 301 to that film's page      |
| A slug exactly one showing film is listed under   | 302 to that film's page      |
| A long slug close to exactly one showing film's   | 302 to that film's page      |
| Two or more showing films match, or none do       | the site's 404, unchanged    |
| A file under a page (`index.txt`, `__next.*.txt`) | the site's 404, unchanged    |
| Anything but `GET` or `HEAD`                      | the site's 404, unchanged    |
| The map can't be read, or contradicts itself      | the site's 404, and an error |

The query string goes with a redirect, so `?venues=…` and the other filters a
link set still apply. A fragment such as `#show-all` never reaches the server;
browsers carry it across a redirect themselves.

### Why each rule is what it is

**A known id** is the page, whatever the slug says, so it's permanent. It
covers TheMovieDB renaming a film (`the-killer-condom` → `killer-condom`), a
venue retitling an event, a link cut short when it was shared, the wrong case,
and `/movies/<id>/` with no slug. Departed films count: their pages stay up
for as long as the pipeline's seen registry remembers them.

**A matched listing** is exact rather than a guess. An unmatched listing's id
is the first 8 hex characters of the SHA-256 of the venue's title (`getId` in
clusterflick/scripts' `common/utils.js`). When the listing is matched, the
film keeps the venue's title on its showing, so hashing every showing film's
venue titles gives the old ids back. A hash two films carry is left out.

**A slug match** is only true of today's listings: a second film under the
same title could open next week. So it's a 302, and it only counts **showing**
films. A departed film's own URL is a page and never gets here, and counting
departed films would only turn one showing Carrie into an ambiguous pair.

**A close slug** catches a retitle ("… African Odysseys at BFI" → "… at the
BFI") and the next edition of a finished event (`…-2026` → `…-2027`), where
that's the only one showing. Measured against the films showing on 19
November 2026:

- **Only slugs of 20 characters or more** (`FUZZY_MIN_LENGTH`). In a short
  slug one edit is usually a different title (`practical-magic` and
  `practical-magic-2` were both showing).
- **Within 10% of the longer slug's length** (`FUZZY_MAX_DISTANCE`). The
  distinct showing titles that close to each other were all siblings: parts 1,
  2 and 3 of one programme, a 17:00 and a 20:00 performance. The one-film rule
  turns those into a 404 rather than picking one. At 15%, different things
  started to meet: Manon and Carmen, Saturday and Sunday brunch.

Everything else stays a 404. Most film 404s are unmatched one-off events that
have finished, and for those a 404 is the honest answer.

Replayed against Search Console's export of 936 film URLs reported as 404s,
once the site had departed pages for every film the seen registry knew: 604
were pages again, 17 were sent on by id or hash, 5 by slug, and 310 stayed
404s.

## The map

The site builds `/movie-urls.json` with every deploy, from the listings and
the departed films (`src/utils/get-movie-url-map.ts` in
clusterflick/clusterflick.com, which documents each field). Version 1 holds:

- `slugs`: every film with a page, showing or departed, and its slug.
- `titleHashes`: the old id of a matched listing, and the showing film it
  became.
- `liveSlugs`: every slug a showing film is listed under (its title, its
  other English titles and its venues' titles), and the films under it.

The Worker reads it from the site with `cache: "no-store"`, since the zone's
"Cache JSON blobs" rule would hold a fixed-name `.json` for a year, and keeps
it for ten minutes (`MAP_TTL_MS`), GitHub Pages' own `max-age`. A refresh
that fails falls back to the map held last, with an error logged; with no map
at all, every 404 stays a 404. A map at a version this Worker wasn't built for
is refused, so a change to its shape has to raise `MOVIE_URL_MAP_VERSION` on
both sides.

## Logs

Each 404 is logged as one JSON line, `{"event":"movie-404","path",…}`, with
either `outcome: "redirect"` and its `status`, `location` and `rule` (`id`,
`title-hash`, `slug`, `fuzzy-slug`), or `outcome: "not-found"` and a `reason`
(`no-match`, `ambiguous`, `not-a-page`, `canonical`), or `outcome: "error"`.
`canonical` is a film's own page answering 404, which means a deploy in
progress or a broken build, and is worth a look if it lasts.

## Passing requests through

Every other Clusterflick Worker sets `global_fetch_strictly_public`, so its
fetches go over the public internet. This one mustn't: passing a request
through is a fetch to its own route, and only same-zone routing sends that to
GitHub Pages. Over the public internet it would come back in through
Cloudflare and reach this Worker again.

## CPU

The fuzzy match compares a slug with each of a few thousand showing slugs,
skipping any whose length alone rules them out and abandoning a comparison
once it passes the threshold. Over the 936 URLs above, the slowest took 5.5ms
in Node. `limits.cpu_ms` is 200, as headroom.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`npm run dev` serves on port 8789 and passes requests to `SITE_ORIGIN`, the
site's `next dev` on port 3000, which serves `/movie-urls.json` too.

```sh
npm run lint
npm test
```

Run `npm run cf-typegen` after changing `wrangler.jsonc`.

## Deployment

`.github/workflows/deploy.yml` lints and tests every push and pull request,
and deploys on pushes to `main`. The Worker has no secrets, so CI creates it
on its first deploy, given the repository secrets `CLOUDFLARE_API_TOKEN` (the
"Edit Cloudflare Workers" template, scoped to the account and the
`clusterflick.com` zone) and `CLOUDFLARE_ACCOUNT_ID`.

It can go live before or after the site starts publishing the map: until
then, every 404 is passed through as it was, with an error logged.

The site's 404 page also redirects in the browser, for films it can find by
id or by a unique title. Once this Worker is live, those reach it first.

## License

MIT. See [LICENSE](LICENSE).
