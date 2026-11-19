import type { MovieUrlMap } from "./map";

/**
 * Below this many characters, a slug must match exactly. One edit in a short
 * slug is usually a different title rather than a typo: `practical-magic`
 * and `practical-magic-2` are both showing, and numbered parts differ by a
 * digit.
 */
export const FUZZY_MIN_LENGTH = 20;

/**
 * The most a slug may differ by, as a share of the longer one's length. At
 * 10%, a retitle such as "… African Odysseys at BFI" → "… at the BFI" (about
 * 6%) is caught, while `carrie` → `carrier` (14%) is not. Measured against
 * the films showing on 19 November 2026, the distinct titles within 10% of
 * each other were all siblings - parts 1, 2 and 3 of one programme, a 17:00
 * and a 20:00 performance - which the one-film rule below turns into a 404.
 * At 15%, different things started to meet: Manon and Carmen, Saturday and
 * Sunday brunch.
 */
export const FUZZY_MAX_DISTANCE = 0.1;

export type Decision =
  | {
      outcome: "redirect";
      status: 301 | 302;
      location: string;
      rule: "id" | "title-hash" | "slug" | "fuzzy-slug";
    }
  | {
      outcome: "not-found";
      reason: "not-a-page" | "canonical" | "ambiguous" | "no-match";
    };

const pagePath = (id: string, slug: string) => `/movies/${id}/${slug}/`;

/**
 * The edit distance between two strings, or Infinity once it must exceed
 * `max` - most comparisons are abandoned within a few characters.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return Infinity;
    previous = current;
  }
  return previous[b.length] <= max ? previous[b.length] : Infinity;
}

/** The films within the fuzzy threshold of a slug, by any of their slugs. */
function findNearby(slug: string, map: MovieUrlMap): Set<string> {
  const ids = new Set<string>();
  for (const [candidate, candidateIds] of Object.entries(map.liveSlugs)) {
    const longer = Math.max(slug.length, candidate.length);
    const max = Math.floor(longer * FUZZY_MAX_DISTANCE);
    if (boundedDistance(slug, candidate, max) <= max) {
      for (const id of candidateIds) ids.add(id);
    }
  }
  return ids;
}

/**
 * Where a film URL that GitHub Pages answered with a 404 should go, if
 * anywhere. Only ever asked about a 404, so a page that exists is never
 * redirected.
 *
 * In order:
 * 1. A known id, under the wrong slug or none: the page moved, when
 *    TheMovieDB or a venue retitled the film, or the link was cut short.
 *    301, since the id is the page.
 * 2. The old id of a venue's listing that has since been matched to a film:
 *    the film still carries the venue's title, and hashing it gives that id
 *    back exactly (`titleHashes`). 301, for the same reason.
 * 3. A slug that one showing film is listed under, or long enough and close
 *    to one: retitled, or the next edition of a finished event. 302: it's
 *    true of today's listings, and tomorrow's could have two.
 *
 * Departed films are matched by id only. A departed film's own URL is a
 * page, so it never reaches here, and counting departed films in 3 would
 * only turn one showing Carrie into an ambiguous pair.
 */
export function resolve(pathname: string, map: MovieUrlMap): Decision {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "movies" || segments.length < 2) {
    return { outcome: "not-found", reason: "not-a-page" };
  }
  // A file under a page (`index.txt`, `__next.*.txt`) is the client fetching
  // part of a page, which expects that file rather than a page.
  const rest = segments.slice(2);
  if (rest.some((segment) => segment.includes("."))) {
    return { outcome: "not-found", reason: "not-a-page" };
  }

  const id = decodeSegment(segments[1]);
  const slug = decodeSegment(rest[0] ?? "").toLowerCase();

  const known = map.slugs[id] ?? map.slugs[id.toLowerCase()];
  if (known !== undefined) {
    const canonicalId = map.slugs[id] !== undefined ? id : id.toLowerCase();
    const location = pagePath(canonicalId, known);
    // The page itself 404ing is a deploy in progress or a broken build, and
    // sending it to itself would loop.
    if (location === pathname) {
      return { outcome: "not-found", reason: "canonical" };
    }
    return { outcome: "redirect", status: 301, location, rule: "id" };
  }

  const matched = map.titleHashes[id.toLowerCase()];
  if (matched !== undefined) {
    const matchedSlug = map.slugs[matched];
    if (matchedSlug === undefined) {
      throw new Error(`Title hash ${id} names ${matched}, which has no page`);
    }
    return {
      outcome: "redirect",
      status: 301,
      location: pagePath(matched, matchedSlug),
      rule: "title-hash",
    };
  }

  if (!slug) return { outcome: "not-found", reason: "no-match" };

  const exact = map.liveSlugs[slug];
  if (exact) {
    if (exact.length > 1) return { outcome: "not-found", reason: "ambiguous" };
    return redirectToLive(exact[0], map, "slug");
  }

  if (slug.length < FUZZY_MIN_LENGTH) {
    return { outcome: "not-found", reason: "no-match" };
  }
  const nearby = findNearby(slug, map);
  if (nearby.size > 1) return { outcome: "not-found", reason: "ambiguous" };
  if (nearby.size === 0) return { outcome: "not-found", reason: "no-match" };
  return redirectToLive([...nearby][0], map, "fuzzy-slug");
}

function redirectToLive(
  id: string,
  map: MovieUrlMap,
  rule: "slug" | "fuzzy-slug",
): Decision {
  const slug = map.slugs[id];
  if (slug === undefined) {
    throw new Error(`Live slug names ${id}, which has no page`);
  }
  return {
    outcome: "redirect",
    status: 302,
    location: pagePath(id, slug),
    rule,
  };
}

/** A path segment as text; a malformed escape is left as it came. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
