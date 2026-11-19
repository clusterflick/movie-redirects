import { getMap } from "./map";
import { resolve, type Decision } from "./resolve";

/**
 * How long a browser may keep a 301. A slug can move again, and a browser
 * holding an old 301 forever would land on the page it pointed at, then be
 * sent on again from there; a day keeps the hop cheap without making it
 * permanent.
 */
const PERMANENT_MAX_AGE = 24 * 60 * 60;

function log(path: string, decision: Decision | { outcome: "error" }) {
  console.log(JSON.stringify({ event: "movie-404", path, ...decision }));
}

/**
 * Every film URL, passed through to the site. Only a 404 from the site is
 * looked at, so a page that exists is served exactly as GitHub Pages serves
 * it; a 404 with nowhere to go, or one the Worker can't look up, is that same
 * 404.
 */
export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const response = await fetch(
    new Request(new URL(url.pathname + url.search, env.SITE_ORIGIN), request),
  );
  if (
    response.status !== 404 ||
    (request.method !== "GET" && request.method !== "HEAD")
  ) {
    return response;
  }

  let decision: Decision;
  try {
    const { map, stale } = await getMap(env.SITE_ORIGIN);
    if (stale) console.error("Using the last map held", stale);
    decision = resolve(url.pathname, map);
  } catch (error) {
    console.error("Couldn't look up a moved film", error);
    log(url.pathname, { outcome: "error" });
    return response;
  }

  log(url.pathname, decision);
  if (decision.outcome !== "redirect") return response;

  // The query string goes with it: filters a link set, such as `?venues=`.
  // A fragment never reaches the server; browsers carry it over themselves.
  const location = new URL(decision.location + url.search, url);
  return new Response(null, {
    status: decision.status,
    headers: {
      Location: location.toString(),
      "Cache-Control":
        decision.status === 301
          ? `public, max-age=${PERMANENT_MAX_AGE}`
          : "no-store",
    },
  });
}

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
