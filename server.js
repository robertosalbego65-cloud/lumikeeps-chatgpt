import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const catalogPath = new URL("./lumikeeps_catalog_mvp.json", import.meta.url);
const catalogData = JSON.parse(readFileSync(catalogPath, "utf8"));
const listings = catalogData.listings ?? [];

function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const conceptExpansions = [
  { test: /\b(nonni|nonno|nonna|nipoti|nipote)\b/, add: "family grandparents family gift" },
  { test: /\b(famiglia|familiare|familiari|figli|figlio|figlia|mamma|madre|papa|padre)\b/, add: "family portrait family gift" },
  { test: /\b(coppia|fidanzato|fidanzata|marito|moglie|partner)\b/, add: "couple portrait anniversary" },
  { test: /\b(matrimonio|sposi|sposa|sposo|nozze)\b/, add: "wedding couple engagement" },
  { test: /\b(anniversario|san valentino|valentino)\b/, add: "anniversary valentine couple" },
  { test: /\b(amico|amica|amici|amiche|bff)\b/, add: "best friends friendship bff" },
  { test: /\b(lontano|lontana|distanza|estero|america)\b/, add: "long distance friendship abroad" },
  { test: /\b(cane|cagnolino|gatto|gattino|animale|animali|pet)\b/, add: "pet dog cat pet portrait" },
  { test: /\b(morto|morta|scomparso|scomparsa|mancato|mancata|ricordo|ricordare|memoriale|commemorativo|commemorativa)\b/, add: "memorial remembrance bereavement loved one rainbow bridge" },
  { test: /\b(natale|natalizio|natalizia)\b/, add: "christmas holiday" },
  { test: /\b(halloween)\b/, add: "halloween spooky" },
  { test: /\b(moto|motocicletta|motociclista|biker)\b/, add: "motorcycle biker motorbike" },
  { test: /\b(auto|macchina|automobile|car)\b/, add: "car automotive car lover" },
  { test: /\b(foto separate|fotografie separate|foto diverse|fotografie diverse|unire foto|unire fotografie)\b/, add: "separate photos combine photos" },
  { test: /\b(prima e adesso|ieri e oggi|then and now)\b/, add: "then and now friendship memories" },
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
    ...(listing.keywords ?? []),
    ...(listing.occasion ?? []),
    listing.memorial ? "memorial remembrance" : "",
    listing.separate_photos ? "separate photos combine photos" : "",
    listing.pets_allowed ? "pet dog cat" : "",
  ].join(" "));
}

function scoreListing(query, listing) {
  const expanded = expandQuery(query);
  const haystack = searchableText(listing);
  const words = [...new Set(expanded.split(" ").filter((w) => w.length >= 3))];

  let score = 0;
  for (const word of words) {
    if (haystack.includes(word)) score += 2;
  }

  const q = normalize(query);

  if (/\b(morto|morta|scomparso|scomparsa|mancato|mancata|memoriale|ricordo|ricordare)\b/.test(q)) {
    score += listing.memorial ? 18 : -8;
  }
  if (/\b(cane|gatto|animale|pet)\b/.test(q)) {
    score += listing.pets_allowed ? 10 : -4;
  }
  if (/\b(famiglia|nonni|nipoti|figli|mamma|papa|madre|padre)\b/.test(q)) {
    score += listing.people === "family" ? 10 : 0;
  }
  if (/\b(coppia|fidanzato|fidanzata|marito|moglie|partner)\b/.test(q)) {
    score += listing.people === "couple" ? 10 : 0;
  }
  if (/\b(amico|amica|amici|amiche|bff)\b/.test(q)) {
    score += listing.people === "friends" ? 10 : 0;
  }
  if (/\b(foto separate|fotografie separate|foto diverse|fotografie diverse|unire foto|unire fotografie)\b/.test(q)) {
    score += listing.separate_photos ? 12 : -3;
  }
  if (/\b(natale|natalizio|natalizia)\b/.test(q)) {
    score += (listing.occasion ?? []).includes("christmas") ? 14 : 0;
  }
  if (/\bhalloween\b/.test(q)) {
    score += (listing.occasion ?? []).includes("halloween") ? 14 : 0;
  }
  if (/\b(moto|motocicletta|motociclista|biker)\b/.test(q)) {
    score += haystack.includes("motorcycle") || haystack.includes("biker") ? 16 : 0;
  }
  if (/\b(auto|macchina|automobile)\b/.test(q)) {
    score += haystack.includes("car lover") || haystack.includes("automotive") ? 16 : 0;
  }
  if (/\b(lontano|lontana|distanza|estero|america)\b/.test(q)) {
    score += haystack.includes("long distance") ? 16 : 0;
  }
  if (/\b(matrimonio|sposi|sposa|sposo|nozze)\b/.test(q)) {
    score += haystack.includes("wedding") ? 16 : 0;
  }

  return score;
}

function findBestListings(query, maxResults = 3) {
  return listings
    .map((listing) => ({ ...listing, _score: scoreListing(query, listing) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, Math.max(1, Math.min(3, maxResults)))
    .map(({ _score, ...listing }) => listing);
}

function createLumiKeepsServer() {
  const server = new McpServer({
    name: "lumikeeps-finder",
    version: "0.1.0",
  });

  server.registerTool(
    "find_lumikeeps_portrait",
    {
      title: "Find LumiKeeps Portrait",
      description:
        "Find the most suitable LumiKeeps Etsy portrait listing for a customer's custom portrait or gift request.",
      inputSchema: {
        query: z.string().min(2).describe("Customer request in Italian or English."),
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
        .map((item, index) => `${index + 1}. ${item.title} — ${item.app_description} — Etsy: ${item.etsy_url}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Recommended LumiKeeps listings for: "${query}"\n\n${summary}`,
          },
        ],
        structuredContent: { query, results },
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

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end(`LumiKeeps MCP server — ${listings.length} listings loaded`);
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

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
  console.log(`LumiKeeps MCP server listening on http://localhost:${port}${MCP_PATH}`);
  console.log(`${listings.length} LumiKeeps listings loaded`);
});
