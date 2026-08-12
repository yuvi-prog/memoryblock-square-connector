# Memory Block Square Connector

Read-only MCP connector exposing Square data (locations, orders, payments, customers,
catalog, inventory, invoices, team members, loyalty, gift cards, bookings, subscriptions,
refunds, disputes) across all Memory Block companies/locations.

Every tool is prefixed `GET_` and only ever reads data — no tool can create, update, void,
or refund anything in Square.

## How it works

- Each company's Square Production Application ID + Access Token lives server-side only,
  either in `companies.json` (local dev, gitignored) or the `SQUARE_COMPANIES_JSON` env var
  (production/Railway). Tokens are never returned to callers.
- The MCP server exposes a single `/mcp` endpoint (Streamable HTTP transport), gated by a
  `CONNECTOR_SECRET` bearer token.
- Callers pass a `company` name (see `GET_companies`) and the server resolves the right
  token internally before calling Square.

## Local dev

```
npm install
CONNECTOR_SECRET=<pick-a-secret> npm start
```

## Adding as a Claude connector

Add a custom connector pointing at `https://<your-railway-domain>/mcp` with header
`Authorization: Bearer <CONNECTOR_SECRET>`.

## Env vars (Railway)

- `CONNECTOR_SECRET` — shared secret required to call the connector
- `SQUARE_COMPANIES_JSON` — JSON array of `{ name, applicationId, accessToken }`
