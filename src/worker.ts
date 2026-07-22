/**
 * Daemon Worker — serves the static daemon site plus two live behaviors:
 *
 *  1. /daemon-data.json — the static asset with expired ephemera stripped at
 *     serve time (status, now, offerings, requesting, location). The edge is
 *     the enforcement point: even a stale deploy never serves expired items.
 *
 *  2. /feed.json — normalized recent-activity items (blog, newsletter, video,
 *     code, posts) aggregated on a cron from PUBLIC sources only. Source list
 *     comes from the `feeds` section of daemon-data.json, so this code stays
 *     fully generic for forks.
 *
 * Security invariant: this worker reads ONLY its own assets, its own KV, and
 * public URLs listed in the deployed daemon-data.json. It has no path to any
 * private data. The only secret is an optional X_BEARER_TOKEN for reading the
 * owner's own public tweets.
 */

export interface Env {
  ASSETS: Fetcher;
  FEED_KV: KVNamespace;
  X_BEARER_TOKEN?: string;
  BEEHIIV_API_KEY?: string;
  APIFY_API_KEY?: string;
}

const FEED_KEY = "feed";
const FEED_STALE_MS = 45 * 60 * 1000; // lazy refresh if cron missed a beat
const FEED_MAX_ITEMS = 60;
const FETCH_UA = "Mozilla/5.0 (compatible; DaemonFeed/1.0; +https://github.com/danielmiessler/Daemon)";

// ─── Types ───

interface FeedSource {
  type: "rss" | "github" | "x" | "beehiiv" | "linkedin";
  name: string;
  url?: string;
  user?: string;
  username?: string;
  user_id?: string;
  publication_id?: string;
  profile_url?: string;
  max?: number;
}

interface FeedItem {
  source: string;
  type: string;
  title: string;
  url: string;
  date: string; // ISO
}

interface FeedPayload {
  updated: string;
  items: FeedItem[];
  sources: Array<{ name: string; ok: boolean; count: number; error?: string }>;
}

// ─── Ephemera stripping (TTL enforcement at the edge) ───

function isExpired(expires: unknown, now: number): boolean {
  if (typeof expires !== "string") return false;
  const t = Date.parse(expires);
  return !Number.isNaN(t) && t < now;
}

export function stripEphemera(data: Record<string, any>, nowMs = Date.now()): Record<string, any> {
  const d = { ...data };

  if (d.status && isExpired(d.status.expires, nowMs)) d.status = null;

  if (d.now_meta && isExpired(d.now_meta.expires, nowMs)) {
    d.now = null;
    d.now_meta = null;
  }

  for (const key of ["offerings", "requesting"]) {
    if (Array.isArray(d[key])) {
      d[key] = d[key].filter((item: any) => !isExpired(item?.expires, nowMs));
    }
  }

  if (d.location_meta && isExpired(d.location_meta.expires, nowMs)) {
    d.current_location = d.location_default || d.current_location;
    d.location_meta = null;
  }

  d.served_at = new Date(nowMs).toISOString();
  return d;
}

// ─── Feed source pollers (public URLs only) ───

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1] ?? "") : "";
}

/** Minimal RSS 2.0 / Atom parser — enough for real-world blog/newsletter/YouTube feeds. */
export function parseFeed(xml: string, sourceName: string, max: number): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];

  for (const block of blocks.slice(0, max)) {
    const title = tag(block, "title");
    // Atom: <link href="..."/>; RSS: <link>...</link>
    const atomLink = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
    const url = atomLink ? decodeEntities(atomLink[1] ?? "") : tag(block, "link");
    const date = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated");
    const parsed = Date.parse(date);
    if (!title || !url || Number.isNaN(parsed)) continue;
    items.push({ source: sourceName, type: "rss", title, url, date: new Date(parsed).toISOString() });
  }
  return items;
}

async function pollRss(src: FeedSource): Promise<FeedItem[]> {
  const res = await fetch(src.url!, { headers: { "User-Agent": FETCH_UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), src.name, src.max ?? 8);
}

function summarizeGithubEvent(ev: any): string | null {
  const repo = ev.repo?.name?.split("/")?.pop() ?? "a repo";
  switch (ev.type) {
    case "PushEvent": {
      const n = ev.payload?.size ?? ev.payload?.commits?.length ?? 0;
      return n > 0 ? `Pushed ${n} commit${n === 1 ? "" : "s"} to ${repo}` : `Pushed to ${repo}`;
    }
    case "ReleaseEvent":
      return `Released ${ev.payload?.release?.tag_name ?? "a version"} of ${repo}`;
    case "CreateEvent":
      return ev.payload?.ref_type === "repository" ? `Created repository ${repo}` : null;
    case "PublicEvent":
      return `Open-sourced ${repo}`;
    default:
      return null;
  }
}

async function pollGithub(src: FeedSource): Promise<FeedItem[]> {
  const res = await fetch(`https://api.github.com/users/${src.user}/events/public?per_page=30`, {
    headers: { "User-Agent": FETCH_UA, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const events = (await res.json()) as any[];

  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const title = summarizeGithubEvent(ev);
    if (!title || seen.has(title)) continue; // collapse consecutive pushes to same repo
    seen.add(title);
    items.push({
      source: src.name,
      type: "github",
      title,
      url: `https://github.com/${ev.repo?.name ?? src.user}`,
      date: new Date(ev.created_at).toISOString(),
    });
    if (items.length >= (src.max ?? 6)) break;
  }
  return items;
}

async function pollX(src: FeedSource, token: string): Promise<FeedItem[]> {
  const res = await fetch(
    `https://api.x.com/2/users/${src.user_id}/tweets?max_results=${Math.max(5, src.max ?? 8)}&tweet.fields=created_at&exclude=replies,retweets`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": FETCH_UA } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as any;

  return ((body.data as any[]) || []).slice(0, src.max ?? 8).map((t) => {
    // A bare t.co shortlink means an image/link-only tweet — don't headline a naked URL
    const text = /^https:\/\/t\.co\/\w+$/.test(t.text.trim()) ? "Shared a link" : t.text;
    return {
      source: src.name,
      type: "x",
      title: text.length > 200 ? text.slice(0, 197) + "…" : text,
      url: `https://x.com/${src.username}/status/${t.id}`,
      date: new Date(t.created_at).toISOString(),
    };
  });
}

/** Beehiiv newsletters block feed scrapers; the official API is the reliable read path. */
async function pollBeehiiv(src: FeedSource, apiKey: string): Promise<FeedItem[]> {
  const res = await fetch(
    `https://api.beehiiv.com/v2/publications/${src.publication_id}/posts?limit=${src.max ?? 5}&status=confirmed&order_by=publish_date&direction=desc`,
    { headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": FETCH_UA } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as any;

  return ((body.data as any[]) || []).map((p) => ({
    source: src.name,
    type: "rss",
    title: p.title,
    url: p.web_url,
    date: new Date(p.publish_date * 1000).toISOString(),
  }));
}

/**
 * LinkedIn has no RSS/read API for own posts; the Apify actor takes ~3 min per
 * run, so it gets its own KV cache on a slow cadence and refreshes ONLY inside
 * the cron (never on a request path). Post dates derive from the activity URN —
 * LinkedIn IDs carry epoch-ms in the top 41 bits.
 */
const LI_KEY = "feed:linkedin";
// 24h cadence: the actor bills per scraped post (a capless run cost $1.58 on
// 2026-07-21 — `maxPosts` is not a real input; `limitPerSource` is).
const LI_STALE_MS = 24 * 60 * 60 * 1000;

function linkedinUrnDate(urn: string): string | null {
  const id = urn.split(":").pop() ?? "";
  if (!/^\d{15,}$/.test(id)) return null;
  const ms = Number(BigInt(id) >> 22n);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

async function pollLinkedIn(src: FeedSource, apiKey: string): Promise<FeedItem[]> {
  const res = await fetch(
    `https://api.apify.com/v2/acts/supreme_coder~linkedin-post/run-sync-get-dataset-items?token=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [src.profile_url], limitPerSource: src.max ?? 8, deepScrape: false }),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const posts = (await res.json()) as any[];

  return posts
    .map((p) => {
      const date = linkedinUrnDate(p.urn ?? "");
      const text = (p.text ?? "").trim();
      if (!date || !p.url || !text) return null;
      const clean = text.replace(/\s+/g, " ");
      return {
        source: src.name,
        type: "linkedin",
        title: clean.length > 200 ? clean.slice(0, 197) + "…" : clean,
        url: (p.url as string).split("?")[0] ?? p.url,
        date,
      } as FeedItem;
    })
    .filter((i): i is FeedItem => i !== null)
    .slice(0, src.max ?? 8);
}

async function linkedinItems(src: FeedSource, env: Env, allowSlow: boolean): Promise<FeedItem[]> {
  const cached = await env.FEED_KV.get(LI_KEY);
  const parsed = cached ? (JSON.parse(cached) as { updated: string; items: FeedItem[] }) : null;
  const fresh = parsed && Date.now() - Date.parse(parsed.updated) < LI_STALE_MS;

  if (fresh || !allowSlow) {
    if (!parsed) throw new Error(allowSlow ? "no cache" : "no cache yet (populates on next cron)");
    return parsed.items;
  }
  if (!env.APIFY_API_KEY) throw new Error("no APIFY_API_KEY secret configured");
  const items = await pollLinkedIn(src, env.APIFY_API_KEY);
  await env.FEED_KV.put(LI_KEY, JSON.stringify({ updated: new Date().toISOString(), items }));
  return items;
}

// ─── Aggregation ───

async function loadDaemonData(env: Env): Promise<Record<string, any> | null> {
  const res = await env.ASSETS.fetch(new Request("https://assets.local/daemon-data.json"));
  if (!res.ok) return null;
  return (await res.json()) as Record<string, any>;
}

export async function refreshFeed(env: Env, allowSlow = false): Promise<FeedPayload> {
  const data = await loadDaemonData(env);
  const sources: FeedSource[] = Array.isArray(data?.feeds) ? data!.feeds : [];

  const results = await Promise.allSettled(
    sources.map(async (src) => {
      if (src.type === "rss") return { src, items: await pollRss(src) };
      if (src.type === "github") return { src, items: await pollGithub(src) };
      if (src.type === "x") {
        if (!env.X_BEARER_TOKEN) throw new Error("no X_BEARER_TOKEN secret configured");
        return { src, items: await pollX(src, env.X_BEARER_TOKEN) };
      }
      if (src.type === "beehiiv") {
        if (!env.BEEHIIV_API_KEY) throw new Error("no BEEHIIV_API_KEY secret configured");
        return { src, items: await pollBeehiiv(src, env.BEEHIIV_API_KEY) };
      }
      if (src.type === "linkedin") return { src, items: await linkedinItems(src, env, allowSlow) };
      throw new Error(`unknown source type: ${src.type}`);
    })
  );

  const items: FeedItem[] = [];
  const report: FeedPayload["sources"] = [];
  results.forEach((r, i) => {
    const name = sources[i]?.name ?? `source-${i}`;
    if (r.status === "fulfilled") {
      items.push(...r.value.items);
      report.push({ name, ok: true, count: r.value.items.length });
    } else {
      report.push({ name, ok: false, count: 0, error: String(r.reason?.message ?? r.reason) });
    }
  });

  items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const payload: FeedPayload = { updated: new Date().toISOString(), items: items.slice(0, FEED_MAX_ITEMS), sources: report };

  await env.FEED_KV.put(FEED_KEY, JSON.stringify(payload));
  return payload;
}

// ─── Handlers ───

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/daemon-data.json") {
      const data = await loadDaemonData(env);
      if (!data) return new Response(JSON.stringify({ error: "no data" }), { status: 404, headers: JSON_HEADERS });
      return new Response(JSON.stringify(stripEphemera(data), null, 2), { headers: JSON_HEADERS });
    }

    if (pathname === "/feed.json") {
      const cached = await env.FEED_KV.get(FEED_KEY);
      if (!cached) {
        const fresh = await refreshFeed(env);
        return new Response(JSON.stringify(fresh), { headers: JSON_HEADERS });
      }
      const payload = JSON.parse(cached) as FeedPayload;
      if (Date.now() - Date.parse(payload.updated) > FEED_STALE_MS) {
        ctx.waitUntil(refreshFeed(env)); // serve stale, refresh in background
      }
      return new Response(cached, { headers: JSON_HEADERS });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshFeed(env, true)); // cron may run slow sources (LinkedIn actor ~3 min)
  },
} satisfies ExportedHandler<Env>;
