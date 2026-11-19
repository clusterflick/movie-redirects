import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { clearMap, MAP_TTL_MS, type MovieUrlMap } from "../src/map";

const MAP: MovieUrlMap = {
  version: 1,
  generatedAt: "2026-11-19T05:20:34Z",
  slugs: { "10542": "killer-condom", "1339713": "obsession" },
  titleHashes: {},
  liveSlugs: { obsession: ["1339713"] },
};

type Site = {
  pages?: Record<string, number>;
  map?: () => Response;
};

let requests: { url: string; init?: RequestInit }[];

/** The site: a page's status by path, and the map. */
function serve({ pages = {}, map = () => Response.json(MAP) }: Site = {}) {
  requests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ url: request.url, init });
    if (url.pathname === "/movie-urls.json") return map();
    const status = pages[url.pathname] ?? 404;
    return new Response(status === 404 ? "Page Not Found" : "page", {
      status,
      headers: { "Content-Type": "text/html" },
    });
  });
}

const get = (path: string, init?: RequestInit) =>
  handleRequest(new Request(`https://clusterflick.com${path}`, init), env);

const mapFetches = () =>
  requests.filter(({ url }) => url.endsWith("/movie-urls.json"));

// Held rather than read back off `console`, whose methods are bound in the
// Workers runtime.
let logged: ReturnType<typeof vi.spyOn>;
let errored: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearMap();
  logged = vi.spyOn(console, "log").mockImplementation(() => {});
  errored = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a page that exists", () => {
  it("is the site's own response, without reading the map", async () => {
    serve({ pages: { "/movies/10542/killer-condom/": 200 } });
    const response = await get("/movies/10542/killer-condom/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page");
    expect(mapFetches()).toHaveLength(0);
  });

  it("keeps the site's own redirects", async () => {
    serve({ pages: { "/movies/10542/killer-condom": 301 } });
    expect((await get("/movies/10542/killer-condom")).status).toBe(301);
    expect(mapFetches()).toHaveLength(0);
  });
});

describe("a film that moved", () => {
  it("is a 301 to its page, keeping the query string", async () => {
    serve();
    const response = await get(
      "/movies/10542/the-killer-condom/?venues=rio-cinema&allDates=true",
    );
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(
      "https://clusterflick.com/movies/10542/killer-condom/?venues=rio-cinema&allDates=true",
    );
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("is a 302 when only the title says where it went", async () => {
    serve();
    const response = await get("/movies/3add0819/obsession/");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://clusterflick.com/movies/1339713/obsession/",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is logged as one line", async () => {
    serve();
    await get("/movies/10542/the-killer-condom/");
    expect(logged).toHaveBeenCalledWith(
      JSON.stringify({
        event: "movie-404",
        path: "/movies/10542/the-killer-condom/",
        outcome: "redirect",
        status: 301,
        location: "/movies/10542/killer-condom/",
        rule: "id",
      }),
    );
  });
});

describe("a 404 with nowhere to go", () => {
  it("is the site's own 404", async () => {
    serve();
    const response = await get("/movies/de4fb93c/bbc-proms-bond-and-beyond/");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Page Not Found");
  });

  it("is left alone for anything but GET and HEAD", async () => {
    serve();
    const response = await get("/movies/10542/the-killer-condom/", {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(mapFetches()).toHaveLength(0);
  });
});

describe("the map", () => {
  it("is fetched bypassing Cloudflare's cache", async () => {
    serve();
    await get("/movies/10542/the-killer-condom/");
    expect(mapFetches()).toEqual([
      {
        url: "https://clusterflick.com/movie-urls.json",
        init: { cache: "no-store" },
      },
    ]);
  });

  it("is held for ten minutes, then fetched again", async () => {
    serve();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    await get("/movies/10542/a/");
    await get("/movies/10542/b/");
    expect(mapFetches()).toHaveLength(1);
    now.mockReturnValue(1_000_000 + MAP_TTL_MS);
    await get("/movies/10542/c/");
    expect(mapFetches()).toHaveLength(2);
  });

  it("is the 404 as it was when it can't be read", async () => {
    serve({ map: () => new Response("Not Found", { status: 404 }) });
    const response = await get("/movies/10542/the-killer-condom/");
    expect(response.status).toBe(404);
    expect(errored).toHaveBeenCalled();
  });

  it("is refused at a version this Worker wasn't built for", async () => {
    serve({ map: () => Response.json({ ...MAP, version: 2 }) });
    const response = await get("/movies/10542/the-killer-condom/");
    expect(response.status).toBe(404);
    expect(errored).toHaveBeenCalledWith(
      "Couldn't look up a moved film",
      expect.objectContaining({ message: expect.stringMatching(/version 2/) }),
    );
  });

  it("is used as last held when a refresh fails", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    serve();
    await get("/movies/10542/a/");
    now.mockReturnValue(1_000_000 + MAP_TTL_MS);
    serve({ map: () => new Response("Bad Gateway", { status: 502 }) });
    const response = await get("/movies/10542/b/");
    expect(response.status).toBe(301);
    expect(errored).toHaveBeenCalledWith(
      "Using the last map held",
      expect.anything(),
    );
  });
});
