import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { tools } from "./tools.js";
import { syncRow, SYNC_MODE, IMAGE_COLUMN_ID } from "./monday.js";

const PORT = process.env.PORT || 3000;
const CONNECTOR_SECRET = process.env.CONNECTOR_SECRET;

if (!CONNECTOR_SECRET) {
  console.error("CONNECTOR_SECRET env var is required - refusing to start without an auth gate.");
  process.exit(1);
}

function buildServer() {
  const server = new McpServer({ name: "memoryblock-square", version: "1.0.0" });
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
      try {
        const result = await tool.handler(args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  }
  return server;
}

const app = express();
// Raised from Express's 100kb default so base64-encoded product images (ATTACH_item_image)
// fit in one request; Square itself caps catalog images at 15MB.
app.use(express.json({ limit: "20mb" }));

// The bearer-secret gate only applies to the MCP endpoint - Monday's webhook can't
// send our secret, so it's scoped out and instead only trusts requests naming our board.
app.use("/mcp", (req, res, next) => {
  const auth = req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (token !== CONNECTOR_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

const MONDAY_BOARD_ID = "5030789525";

app.post("/monday-webhook", async (req, res) => {
  // Monday's subscription handshake: echo the challenge straight back, unmodified.
  if (req.body?.challenge) {
    res.json({ challenge: req.body.challenge });
    return;
  }

  // React to the Square toggle (create/hide) or the image column (attach a photo
  // to an already-ticked, already-existing item without waiting for a re-tick).
  const event = req.body?.event;
  const relevantColumns = ["boolean_mm6fa9h8", IMAGE_COLUMN_ID];
  if (!event || String(event.boardId) !== MONDAY_BOARD_ID || !relevantColumns.includes(event.columnId)) {
    res.status(200).json({ ignored: true });
    return;
  }

  // Ack immediately - Monday expects a fast response and will retry on timeout.
  res.status(200).json({ received: true });

  try {
    const plan = await syncRow(event.pulseId);
    console.log(`[monday-sync:${SYNC_MODE}]`, JSON.stringify(plan));
  } catch (err) {
    console.error("[monday-sync] failed:", err.message);
  }
});

const transports = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    const server = buildServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Unknown session");
    return;
  }
  await transport.handleRequest(req, res);
});

app.get("/health", (req, res) => res.json({ ok: true, mondaySyncMode: SYNC_MODE }));

app.listen(PORT, () => {
  console.log(`Memory Block Square MCP connector listening on :${PORT}`);
});
