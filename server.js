import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { buildEtsyCatalog } from "./etsy-sync.js";

const catalogPath = new URL("./lumikeeps_catalog_mvp.json", import.meta.url);
const catalogData = JSON.parse(readFileSync(catalogPath, "utf8"));
const curatedListings = catalogData.listings ?? [];

let listings = [...curatedListings];
let catalogSource = "static";
let lastRefreshAt = null;
let lastRefreshError = null;
const ETSY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const TEMPLATE_URI = "ui://lumikeeps/portrait-carousel-v1.html";

function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function inferMetadata(listing) {
  const text = normalize([
    listing.title,
    listing.description,
    ...(listing.tags ?? []),
  ].join(" "));

  let people = "other";
  let category = "Other";

  if (/\b(family|famiglia|grandparent|nonni|mother|father|parents)\b/.test(text)) {
    people = "family";
    category = "Family";
  }

  if (/\b(couple|wedding|anniversary|husband|wife|boyfriend|girlfriend)\b/.test(text)) {
    people = "couple";
    category = "Couple";
  }

  if (/\b(friend|friends|friendship|bff|bestie)\b/.test(text)) {
    people = "friends";
    category = "Best Friends";
  }

  if (/\b(pet|dog|cat|puppy|kitten)\b/.test(text)) {
    people = people === "other" ? "none" : people;
    category = people === "none" ? "Pet" : category;
  }

  const memorial =
    /\b(memorial|remembrance|rainbow bridge|loss|bereavement|in memory)\b/.test(text);

  if (memorial) {
    category = "Memorial";
  }

  return {
    people,
    category,
    pets_allowed: /\b(pet|dog|cat|puppy|kitten)\b/.test(text),
    separate_photos:
      /\b(separate photo|separate photos|combine photos|multiple photos)\b/.test(text),
    memorial,
  };
}

function mergeLiveListing(liveListing) {
  const curated = curatedListings.find(
    (item) => String(item.listing_id) === String(liveListing.listing_id)
  );

  const inferred = inferMetadata(liveListing);

  if (!curated) {
    return {
      ...liveListing,
      ...inferred,
      keywords: unique(liveListing.tags ?? []),
      occasion: [],
      app_description: liveListing.description
        ? String(liveListing.description).slice(0, 280)
        : "Ritratto personalizzato LumiKeeps.",
    };
  }

  return {
    ...inferred,
    ...liveListing,
    ...curated,
    title: liveListing.title || curated.title,
    etsy_url: liveListing.etsy_url || curated.etsy_url,
    keywords: unique([
      ...(curated.keywords ?? []),
      ...(liveListing.tags ?? []),
    ]),
    description: liveListing.description ?? "",
    primary_image: liveListing.primary_image ?? curated.primary_image ?? null,
    images: liveListing.images ?? curated.images ?? [],
    price: liveListing.price ?? curated.price ?? null,
  };
}

async function refreshCatalogFromEtsy() {
  try {
    const liveCatalog = await buildEtsyCatalog();

    if (!Array.isArray(liveCatalog.listings) || liveCatalog.listings.length === 0) {
      throw new Error("Etsy returned an empty catalog.");
    }

    listings = liveCatalog.listings.map(mergeLiveListing);
    catalogSource = "etsy-live";
    lastRefreshAt = new Date().toISOString();
    lastRefreshError = null;

    console.log(`Etsy catalog refreshed: ${listings.length} active listings`);
  } catch (error) {
    lastRefreshError = error instanceof Error ? error.message : String(error);
    console.error("Etsy catalog refresh failed:", lastRefreshError);
  }
}

function etsyConfigAvailable() {
  return Boolean(
    process.env.ETSY_KEYSTRING &&
    process.env.ETSY_SHARED_SECRET
  );
}

const conceptExpansions = [
  {
    test: /\b(nonni|nonno|nonna|nipoti|nipote|grandparents|grandmother|grandfather)\b/,
    add: "family grandparents family gift",
  },
  {
    test: /\b(famiglia|familiare|familiari|figli|figlio|figlia|mamma|madre|papa|padre|family|parents)\b/,
    add: "family portrait family gift",
  },
  {
    test: /\b(coppia|fidanzato|fidanzata|marito|moglie|partner|couple|husband|wife)\b/,
    add: "couple portrait anniversary",
  },
  {
    test: /\b(matrimonio|sposi|sposa|sposo|nozze|wedding|engagement)\b/,
    add: "wedding couple engagement",
  },
  {
    test: /\b(anniversario|san valentino|valentino|anniversary|valentine)\b/,
    add: "anniversary valentine couple",
  },
  {
    test: /\b(amico|amica|amici|amiche|bff|friend|friends|friendship|bestie)\b/,
    add: "best friends friendship bff",
  },
  {
    test: /\b(lontano|lontana|distanza|estero|america|long distance|abroad)\b/,
    add: "long distance friendship abroad",
  },
  {
    test: /\b(cane|cagnolino|gatto|gattino|animale|animali|pet|dog|cat)\b/,
    add: "pet dog cat pet portrait",
  },
  {
    test: /\b(morto|morta|scomparso|scomparsa|mancato|mancata|ricordo|ricordare|memoriale|memorial|remembrance)\b/,
    add: "memorial remembrance bereavement loved one rainbow bridge",
  },
  {
    test: /\b(natale|natalizio|natalizia|christmas|holiday)\b/,
    add: "christmas holiday",
  },
  {
    test: /\b(halloween)\b/,
    add: "halloween spooky",
  },
  {
    test: /\b(moto|motocicletta|motociclista|biker|motorcycle)\b/,
    add: "motorcycle biker motorbike",
  },
  {
    test: /\b(auto|macchina|automobile|car)\b/,
    add: "car automotive car lover",
  },
  {
    test: /\b(foto separate|fotografie separate|foto diverse|fotografie diverse|unire foto|unire fotografie|separate photos|combine photos)\b/,
    add: "separate photos combine photos",
  },
  {
    test: /\b(prima e adesso|ieri e oggi|then and now)\b/,
    add: "then and now friendship memories",
  },
];

function expandQuery(query) {
  const base = normalize(query);
  const additions = [];

  for (const rule of conceptExpansions) {
    if (rule.test.test(base)) additions.push(rule.add);
  }

  return normalize([base, ...additions].join(" "));
}

function searchableText(listing) {
  return normalize([
    listing.title,
    listing.category,
    listing.people,
    listing.app_description,
    listing.description,
    ...(listing.keywords ?? []),
    ...(listing.tags ?? []),
    ...(listing.occasion ?? []),
    listing.memorial ? "memorial remembrance" : "",
    listing.separate_photos ? "separate photos combine photos" : "",
    listing.pets_allowed ? "pet dog cat" : "",
  ].join(" "));
}

function scoreListing(query, listing) {
  const expanded = expandQuery(query);
  const haystack = searchableText(listing);

  const words = [
    ...new Set(
      expanded
        .split(" ")
        .filter((word) => word.length >= 3)
    ),
  ];

  let score = 0;

  for (const word of words) {
    if (haystack.includes(word)) score += 2;
  }

  const q = normalize(query);

  if (/\b(morto|morta|scomparso|scomparsa|memoriale|memorial|ricordo|remembrance)\b/.test(q)) {
    score += listing.memorial ? 18 : -8;
  }

  if (/\b(cane|gatto|animale|pet|dog|cat)\b/.test(q)) {
    score += listing.pets_allowed ? 10 : -4;
  }

  if (/\b(famiglia|nonni|nipoti|figli|mamma|papa|family|parents|grandparents)\b/.test(q)) {
    score += listing.people === "family" ? 10 : 0;
  }

  if (/\b(coppia|fidanzato|fidanzata|marito|moglie|couple|husband|wife)\b/.test(q)) {
    score += listing.people === "couple" ? 10 : 0;
  }

  if (/\b(amico|amica|amici|amiche|bff|friend|friends|bestie)\b/.test(q)) {
    score += listing.people === "friends" ? 10 : 0;
  }

  if (/\b(foto separate|fotografie separate|foto diverse|unire foto|separate photos|combine photos)\b/.test(q)) {
    score += listing.separate_photos ? 12 : -3;
  }

  if (/\b(natale|natalizio|natalizia|christmas)\b/.test(q)) {
    score += haystack.includes("christmas") ? 14 : 0;
  }

  if (/\bhalloween\b/.test(q)) {
    score += haystack.includes("halloween") ? 14 : 0;
  }

  if (/\b(moto|motocicletta|motociclista|biker|motorcycle)\b/.test(q)) {
    score +=
      haystack.includes("motorcycle") || haystack.includes("biker")
        ? 16
        : 0;
  }

  if (/\b(auto|macchina|automobile|car)\b/.test(q)) {
    score +=
      haystack.includes("car lover") || haystack.includes("automotive")
        ? 16
        : 0;
  }

  if (/\b(lontano|lontana|distanza|estero|long distance|abroad)\b/.test(q)) {
    score += haystack.includes("long distance") ? 16 : 0;
  }

  if (/\b(matrimonio|sposi|sposa|sposo|nozze|wedding)\b/.test(q)) {
    score += haystack.includes("wedding") ? 16 : 0;
  }

  return score;
}

function findBestListings(query, maxResults = 3) {
  return listings
    .map((listing) => ({
      ...listing,
      _score: scoreListing(query, listing),
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, Math.max(1, Math.min(3, maxResults)))
    .map(({ _score, ...listing }) => listing);
}

function compactListing(listing) {
  return {
    listing_id: String(listing.listing_id),
    title: listing.title ?? "",
    category: listing.category ?? "Other",
    people: listing.people ?? "other",
    app_description: listing.app_description ?? "Ritratto personalizzato LumiKeeps.",
    etsy_url: listing.etsy_url ?? `https://www.etsy.com/listing/${listing.listing_id}/`,
    primary_image: listing.primary_image ?? null,
    price: listing.price ?? null,
    memorial: Boolean(listing.memorial),
    pets_allowed: Boolean(listing.pets_allowed),
    separate_photos: Boolean(listing.separate_photos),
    occasion: listing.occasion ?? [],
  };
}

function getListingsByIds(listingIds = []) {
  const wanted = new Set(listingIds.map(String));
  const byId = new Map(listings.map((listing) => [String(listing.listing_id), listing]));
  return listingIds
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .slice(0, 3);
}

const widgetHtml = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 14px; background: transparent; color: CanvasText; }
    .shell { display: grid; gap: 12px; }
    .head { display: flex; justify-content: space-between; gap: 12px; align-items: end; }
    .eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; opacity: .62; }
    h2 { margin: 3px 0 0; font-size: 19px; line-height: 1.2; }
    .source { font-size: 12px; opacity: .58; white-space: nowrap; }
    .carousel {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(250px, 82%);
      gap: 12px;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scroll-snap-type: x mandatory;
      padding: 2px 2px 8px;
      scrollbar-width: thin;
    }
    .card {
      scroll-snap-align: start;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 16px;
      overflow: hidden;
      background: color-mix(in srgb, Canvas 96%, CanvasText 4%);
      min-height: 100%;
      display: flex;
      flex-direction: column;
    }
    .media {
      position: relative;
      width: 100%;
      aspect-ratio: 4 / 3;
      background: color-mix(in srgb, Canvas 86%, CanvasText 14%);
      display: grid;
      place-items: center;
      overflow: hidden;
    }
    .media img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .placeholder { font-size: 13px; opacity: .58; padding: 20px; text-align: center; }
    .rank {
      position: absolute;
      left: 10px;
      top: 10px;
      padding: 6px 9px;
      border-radius: 999px;
      background: rgba(0,0,0,.68);
      color: white;
      font-size: 11px;
      font-weight: 700;
      backdrop-filter: blur(8px);
    }
    .body { display: grid; gap: 9px; padding: 13px; flex: 1; }
    .meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .badge {
      font-size: 11px;
      font-weight: 650;
      padding: 4px 7px;
      border-radius: 999px;
      background: color-mix(in srgb, CanvasText 9%, transparent);
    }
    .title { font-size: 16px; line-height: 1.25; font-weight: 750; }
    .desc {
      font-size: 13px;
      line-height: 1.42;
      opacity: .76;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: auto; }
    .price { font-size: 14px; font-weight: 700; min-height: 20px; }
    .cta {
      appearance: none;
      border: 0;
      border-radius: 10px;
      padding: 9px 12px;
      background: CanvasText;
      color: Canvas;
      font: inherit;
      font-size: 13px;
      font-weight: 750;
      text-decoration: none;
      white-space: nowrap;
    }
    .cta:hover { opacity: .86; }
    .empty { padding: 18px; text-align: center; opacity: .65; }
    @media (min-width: 760px) {
      .carousel { grid-auto-columns: minmax(250px, 38%); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="head">
      <div>
        <div class="eyebrow">LumiKeeps</div>
        <h2 id="headline">Ritratti consigliati</h2>
      </div>
      <div id="source" class="source"></div>
    </div>
    <section id="carousel" class="carousel" aria-live="polite"></section>
  </main>

  <script>
    const carousel = document.getElementById("carousel");
    const headline = document.getElementById("headline");
    const sourceEl = document.getElementById("source");
    const locale = (document.documentElement.lang || "it").toLowerCase();
    const isIt = locale.startsWith("it");

    const labels = isIt ? {
      title: "Ritratti consigliati",
      best: "Scelta migliore",
      alt: "Alternativa",
      view: "Vedi su Etsy",
      image: "Anteprima non disponibile",
      live: "catalogo Etsy live",
      static: "catalogo di backup"
    } : {
      title: "Recommended portraits",
      best: "Best match",
      alt: "Alternative",
      view: "View on Etsy",
      image: "Preview unavailable",
      live: "live Etsy catalog",
      static: "backup catalog"
    };

    function formatPrice(price) {
      if (!price) return "";
      if (typeof price === "string" || typeof price === "number") return String(price);
      const amount = Number(price.amount);
      const divisor = Number(price.divisor || 100);
      const currency = price.currency_code || price.currency || "EUR";
      if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor === 0) return "";
      try {
        return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount / divisor);
      } catch {
        return (amount / divisor).toFixed(2) + " " + currency;
      }
    }

    function safeUrl(value) {
      try {
        const u = new URL(String(value));
        return (u.protocol === "https:" || u.protocol === "http:") ? u.href : "";
      } catch { return ""; }
    }

    function render(data) {
      const results = Array.isArray(data?.results) ? data.results.slice(0, 3) : [];
      headline.textContent = data?.headline || labels.title;
      sourceEl.textContent = data?.catalog_source === "etsy-live" ? labels.live : labels.static;
      carousel.replaceChildren();

      if (!results.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = isIt ? "Nessun ritratto da mostrare." : "No portraits to show.";
        carousel.appendChild(empty);
        return;
      }

      results.forEach((item, index) => {
        const card = document.createElement("article");
        card.className = "card";

        const media = document.createElement("div");
        media.className = "media";

        const imageUrl = safeUrl(item.primary_image);
        if (imageUrl) {
          const img = document.createElement("img");
          img.src = imageUrl;
          img.alt = item.title || "LumiKeeps portrait";
          img.loading = "lazy";
          img.referrerPolicy = "no-referrer";
          img.addEventListener("error", () => {
            img.remove();
            const ph = document.createElement("div");
            ph.className = "placeholder";
            ph.textContent = labels.image;
            media.appendChild(ph);
          }, { once: true });
          media.appendChild(img);
        } else {
          const ph = document.createElement("div");
          ph.className = "placeholder";
          ph.textContent = labels.image;
          media.appendChild(ph);
        }

        const rank = document.createElement("span");
        rank.className = "rank";
        rank.textContent = index === 0 ? labels.best : labels.alt;
        media.appendChild(rank);
        card.appendChild(media);

        const body = document.createElement("div");
        body.className = "body";

        const meta = document.createElement("div");
        meta.className = "meta";
        const category = document.createElement("span");
        category.className = "badge";
        category.textContent = item.category || "LumiKeeps";
        meta.appendChild(category);
        if (item.separate_photos) {
          const sep = document.createElement("span");
          sep.className = "badge";
          sep.textContent = isIt ? "Foto separate" : "Separate photos";
          meta.appendChild(sep);
        }
        body.appendChild(meta);

        const title = document.createElement("div");
        title.className = "title";
        title.textContent = item.title || "LumiKeeps";
        body.appendChild(title);

        const desc = document.createElement("div");
        desc.className = "desc";
        desc.textContent = item.app_description || "";
        body.appendChild(desc);

        const footer = document.createElement("div");
        footer.className = "footer";
        const price = document.createElement("div");
        price.className = "price";
        price.textContent = formatPrice(item.price);
        footer.appendChild(price);

        const linkUrl = safeUrl(item.etsy_url);
        if (linkUrl) {
          const cta = document.createElement("a");
          cta.className = "cta";
          cta.href = linkUrl;
          cta.target = "_blank";
          cta.rel = "noopener noreferrer";
          cta.textContent = labels.view;
          footer.appendChild(cta);
        }

        body.appendChild(footer);
        card.appendChild(body);
        carousel.appendChild(card);
      });
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/notifications/tool-result") {
        render(message.params?.structuredContent || {});
      }
    }, { passive: true });

    if (window.openai?.toolOutput) {
      render(window.openai.toolOutput);
    }
  </script>
</body>
</html>
`.trim();

function createLumiKeepsServer() {
  const server = new McpServer({
    name: "lumikeeps-finder",
    version: "3.1.0",
  });

  registerAppResource(
    server,
    "lumikeeps-portrait-carousel",
    TEMPLATE_URI,
    {},
    async () => ({
      contents: [
        {
          uri: TEMPLATE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: ["https://i.etsystatic.com"],
              },
            },
          },
        },
      ],
    })
  );

  server.registerTool(
    "find_lumikeeps_portrait",
    {
      title: "Find LumiKeeps Personalized Portrait",
      description:
        "Find and visually show the best LumiKeeps personalized portraits for a customer's request across the live Etsy catalog. Use for family, couples, best friends, pets, memorials, weddings, anniversaries, birthdays, Christmas, separate photos, combined photos and personalized gift ideas. This tool directly renders the LumiKeeps visual carousel with the best matching Etsy listings.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .describe(
            "Customer request describing the people, pets, occasion, relationship or gift need in Italian or English."
          ),
        max_results: z.number().int().min(1).max(3).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: TEMPLATE_URI },
        "openai/outputTemplate": TEMPLATE_URI,
        "openai/toolInvocation/invoking": "Cerco i ritratti LumiKeeps più adatti…",
        "openai/toolInvocation/invoked": "Ritratti LumiKeeps trovati.",
      },
    },
    async ({ query, max_results }) => {
      const results = findBestListings(query, max_results ?? 3).map(compactListing);

      const summary = results
        .map(
          (item, index) =>
            `${index + 1}. ${item.title} — ${item.app_description} — Etsy: ${item.etsy_url}`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text:
              `Recommended LumiKeeps portraits for: "${query}"\n\n` +
              summary,
          },
        ],
        structuredContent: {
          query,
          headline: "Ritratti LumiKeeps consigliati",
          catalog_source: catalogSource,
          total_catalog_listings: listings.length,
          results,
        },
      };
    }
  );


  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host ?? "localhost"}`
  );

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/.well-known/openai-apps-challenge"
  ) {
    const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? "";

    res
      .writeHead(token ? 200 : 503, {
        "content-type": "text/plain; charset=utf-8",
      })
      .end(token);

    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
      })
      .end(
        `LumiKeeps MCP server V3.1 UI — ${listings.length} listings loaded — source: ${catalogSource}`
      );

    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    res
      .writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      })
      .end(
        JSON.stringify(
          {
            app: "LumiKeeps Finder",
            version: "3.1.0-ui",
            listings_loaded: listings.length,
            catalog_source: catalogSource,
            etsy_configured: etsyConfigAvailable(),
            last_refresh_at: lastRefreshAt,
            last_refresh_error: lastRefreshError,
            auto_refresh_minutes: ETSY_REFRESH_INTERVAL_MS / 60000,
            ui_resource: TEMPLATE_URI,
            ui_mode: "inline-carousel",
          },
          null,
          2
        )
      );

    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);

  if (
    url.pathname === MCP_PATH &&
    req.method &&
    MCP_METHODS.has(req.method)
  ) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id"
    );

    const server = createLumiKeepsServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);

      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }

    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(
    `LumiKeeps MCP server V3.1 UI listening on port ${port}`
  );

  console.log(
    `${listings.length} LumiKeeps listings loaded from static catalog`
  );

  if (etsyConfigAvailable()) {
    refreshCatalogFromEtsy();
  } else {
    console.log(
      "Etsy API not configured yet. Static catalog remains active."
    );
  }
});

if (etsyConfigAvailable()) {
  setInterval(
    refreshCatalogFromEtsy,
    ETSY_REFRESH_INTERVAL_MS
  );
}
