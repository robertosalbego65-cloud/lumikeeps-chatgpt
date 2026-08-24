import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

function createLumiKeepsServer() {
  const server = new McpServer({
    name: "lumikeeps-finder",
    version: "2.0.0",
  });

  server.registerTool(
    "find_lumikeeps_portrait",
    {
      title: "Find LumiKeeps Personalized Portrait",
      description:
        "Recommend the most suitable personalized portrait from the LumiKeeps Etsy catalog. Use for custom portrait gifts involving family, couples, best friends, pets, pet memorials, loved-one memorials, weddings, anniversaries, birthdays, Christmas, separate photos or combined family photos.",
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
    },
    async ({ query, max_results }) => {
      const results = findBestListings(query, max_results ?? 3);

      const summary = results
        .map(
          (item, index) =>
            `${index + 1}. ${item.title} — ${item.app_description ?? ""} — Etsy: ${item.etsy_url}`
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
          catalog_source: catalogSource,
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
    const token =
      process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? "";

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
        `LumiKeeps MCP server V2 — ${listings.length} listings loaded — source: ${catalogSource}`
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
            version: "2.0.0",
            listings_loaded: listings.length,
            catalog_source: catalogSource,
            etsy_configured: etsyConfigAvailable(),
            last_refresh_at: lastRefreshAt,
            last_refresh_error: lastRefreshError,
            auto_refresh_minutes: ETSY_REFRESH_INTERVAL_MS / 60000,
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
    `LumiKeeps MCP server V2 listening on port ${port}`
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
