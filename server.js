import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { recommendConcepts } from "./recommend.js";

const catalog = JSON.parse(
  readFileSync(new URL("./catalog.json", import.meta.url), "utf8")
);

const concepts = Array.isArray(catalog.concepts) ? catalog.concepts : [];

const privacyHtml = readFileSync(
  new URL("./privacy.html", import.meta.url),
  "utf8"
);

const termsHtml = readFileSync(
  new URL("./terms.html", import.meta.url),
  "utf8"
);

const supportHtml = readFileSync(
  new URL("./support.html", import.meta.url),
  "utf8"
);

function createAppServer() {
  const server = new McpServer({
    name: "lumikeeps-portrait-planner",
    version: "1.1.0"
  });

  server.registerTool(
    "plan_personalized_portrait",
    {
      title: "Plan a personalized portrait",

      description:
        "Use this when a user wants help choosing a personalized portrait concept for a family, couple, friendship, pet, or memorial keepsake, or wants guidance on preparing reference photos. It returns up to three non-transactional portrait concepts and photo-preparation guidance. Do not use it to buy, order, price, or check out digital products, and do not use it for unrelated image-editing requests.",

      inputSchema: z.object({
        request: z
          .string()
          .min(2)
          .max(500)
          .describe(
            "A brief, task-specific description of the subjects, relationship, occasion, and desired portrait idea. Names, email addresses, phone numbers, postal addresses, account identifiers, and other personal identifiers are not needed. Example: 'family portrait from separate photos with grandparents and a dog'."
          ),

        max_results: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe(
            "Number of portrait concepts to return, from 1 to 3. Defaults to 3."
          )
      }),

      outputSchema: z.object({
        suggestions: z
          .array(
            z.object({
              concept: z.string(),
              category: z.string(),
              summary: z.string(),
              why_it_fits: z.string(),
              photo_guidance: z.string()
            })
          )
          .min(1)
          .max(3)
      }),

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },

    async ({ request, max_results }) => {
      const results = recommendConcepts(
        request,
        concepts,
        max_results ?? 3
      );

      const text = results
        .map(
          (item, index) =>
            `${index + 1}. ${item.concept}\n` +
            `${item.summary}\n` +
            `Why it fits: ${item.why_it_fits}\n` +
            `Photo guidance: ${item.photo_guidance}`
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Portrait planning suggestions:\n\n${text}`
          }
        ],

        structuredContent: {
          suggestions: results
        }
      };
    }
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const homeHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LumiKeeps Portrait Planner</title>
</head>
<body>
<main>
<h1>LumiKeeps Portrait Planner</h1>
<p>
Helps users plan personalized portrait concepts and prepare suitable reference photos.
This public plugin does not sell products, process payments, or place orders.
</p>
<p>
<a href="/privacy">Privacy Policy</a> ·
<a href="/terms">Terms</a> ·
<a href="/support">Support</a>
</p>
</main>
</body>
</html>`;

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    return res.writeHead(400).end("Missing URL");
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host ?? "localhost"}`
  );

  if (
    req.method === "OPTIONS" &&
    url.pathname === MCP_PATH
  ) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type, mcp-session-id, mcp-protocol-version",
      "Access-Control-Expose-Headers":
        "Mcp-Session-Id"
    });

    return res.end();
  }

  if (
    req.method === "GET" &&
    url.pathname === "/.well-known/openai-apps-challenge"
  ) {
    const token =
      process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? "";

    return res
      .writeHead(token ? 200 : 503, {
        "content-type": "text/plain; charset=utf-8"
      })
      .end(token);
  }

  if (
    req.method === "GET" &&
    url.pathname === "/"
  ) {
    return res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8"
      })
      .end(homeHtml);
  }

  if (
    req.method === "GET" &&
    url.pathname === "/privacy"
  ) {
    return res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8"
      })
      .end(privacyHtml);
  }

  if (
    req.method === "GET" &&
    url.pathname === "/terms"
  ) {
    return res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8"
      })
      .end(termsHtml);
  }

  if (
    req.method === "GET" &&
    url.pathname === "/support"
  ) {
    return res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8"
      })
      .end(supportHtml);
  }

  if (
    req.method === "GET" &&
    url.pathname === "/health"
  ) {
    return res
      .writeHead(200, {
        "content-type": "text/plain; charset=utf-8"
      })
      .end("ok");
  }

  if (
    url.pathname === MCP_PATH &&
    ["POST", "GET", "DELETE"].includes(req.method ?? "")
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id"
    );

    const server = createAppServer();

    const transport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed");

      if (!res.headersSent) {
        res
          .writeHead(500)
          .end("Internal server error");
      }
    }

    return;
  }

  return res
    .writeHead(404)
    .end("Not Found");
});

httpServer.listen(port, () => {
  console.log(
    `LumiKeeps Portrait Planner listening on port ${port}`
  );
});
