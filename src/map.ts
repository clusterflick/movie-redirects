import {
  MOVIE_URL_MAP_FILE,
  MOVIE_URL_MAP_VERSION,
  type MovieUrlMap,
} from "@clusterflick/catalogue/utils/movie-url-map";

/*
 * The site's `/movie-urls.json`. Its shape and version, and the rules that
 * read it, are @clusterflick/catalogue's (`utils/movie-url-map`), shared with
 * data-analysed's Film 404 Log, so the log says what this Worker does. What's
 * here is only how the Worker gets hold of it.
 */
export type { MovieUrlMap };

/**
 * As long as GitHub Pages lets anyone else keep a page (`max-age=600`), so a
 * deploy reaches the redirects within the time it reaches a reader.
 */
export const MAP_TTL_MS = 10 * 60 * 1000;

type Held = { map: MovieUrlMap; fetchedAt: number };

// Per isolate. The map is only read on a 404, so one fetch every ten minutes
// at most, per isolate that sees one.
let held: Held | undefined;
let pending: Promise<MovieUrlMap> | undefined;

/** Forget the held map. For tests. */
export function clearMap() {
  held = undefined;
  pending = undefined;
}

function isMovieUrlMap(value: unknown): value is MovieUrlMap {
  if (typeof value !== "object" || value === null) return false;
  const map = value as Record<string, unknown>;
  return (
    typeof map.slugs === "object" &&
    map.slugs !== null &&
    typeof map.titleHashes === "object" &&
    map.titleHashes !== null &&
    typeof map.liveSlugs === "object" &&
    map.liveSlugs !== null
  );
}

async function fetchMap(origin: string): Promise<MovieUrlMap> {
  // Not from Cloudflare's cache: the zone's "Cache JSON blobs" rule would
  // hold a fixed-name `.json` for a year.
  const response = await fetch(new URL(MOVIE_URL_MAP_FILE, origin), {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${MOVIE_URL_MAP_FILE} answered ${response.status}`);
  }
  const body: unknown = await response.json();
  const version = (body as { version?: unknown } | null)?.version;
  if (version !== MOVIE_URL_MAP_VERSION) {
    throw new Error(
      `${MOVIE_URL_MAP_FILE} is version ${String(version)}; this Worker reads ${MOVIE_URL_MAP_VERSION}`,
    );
  }
  if (!isMovieUrlMap(body)) {
    throw new Error(
      `${MOVIE_URL_MAP_FILE} is missing slugs, titleHashes or liveSlugs`,
    );
  }
  return body;
}

/**
 * The map, fetched at most once per `MAP_TTL_MS` and shared by the requests
 * that arrive while it's being fetched. When a refresh fails, the map held
 * last is used and the failure is thrown only if there is none: a deploy's
 * films moving is the only thing a stale map gets wrong.
 */
export async function getMap(
  origin: string,
  now = Date.now(),
): Promise<{ map: MovieUrlMap; stale?: unknown }> {
  if (held && now - held.fetchedAt < MAP_TTL_MS) return { map: held.map };

  pending ??= fetchMap(origin).finally(() => {
    pending = undefined;
  });
  try {
    const map = await pending;
    held = { map, fetchedAt: now };
    return { map };
  } catch (error) {
    if (held) return { map: held.map, stale: error };
    throw error;
  }
}
