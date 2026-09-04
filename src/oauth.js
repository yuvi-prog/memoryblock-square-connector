// Minimal OAuth 2.0 shim so claude.ai's connector UI (which requires OAuth, not just
// a header) can connect. There's no real user directory here - "login" is just typing
// the same CONNECTOR_SECRET everyone already uses, and the token we hand back IS that
// secret, so the existing bearer-check middleware on /mcp needs no changes at all.
//
// Implements just enough of RFC 8414 (AS metadata), RFC 9728 (protected resource
// metadata), RFC 7591 (dynamic client registration), and the authorization_code +
// PKCE grant for Claude's client to complete a connection. Registered clients and
// pending auth codes are in-memory only (fine - short-lived, single-instance server).
import express from "express";
import { randomUUID, createHash } from "node:crypto";

const CONNECTOR_SECRET = process.env.CONNECTOR_SECRET;

const clients = new Map(); // client_id -> { redirect_uris }
const authCodes = new Map(); // code -> { redirectUri, codeChallenge, codeChallengeMethod, expires }

function baseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function registerOAuthRoutes(app) {
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const origin = baseUrl(req);
    res.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
  });

  // Some MCP clients probe this path variant too.
  app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
    const origin = baseUrl(req);
    res.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const origin = baseUrl(req);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // Dynamic Client Registration (RFC 7591) - accepts any client, no approval needed.
  app.post("/register", (req, res) => {
    const clientId = randomUUID();
    const redirectUris = req.body?.redirect_uris || [];
    clients.set(clientId, { redirectUris });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  });

  // The "login" screen - just asks for the same shared secret used everywhere else.
  app.get("/authorize", (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
    if (response_type !== "code" || !redirect_uri) {
      res.status(400).send("Invalid authorization request.");
      return;
    }
    res.send(`<!doctype html>
<html><head><title>Memory Block Square Connector</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 20px}
input{width:100%;padding:10px;font-size:16px;box-sizing:border-box;margin:12px 0}
button{width:100%;padding:10px;font-size:16px;cursor:pointer}
.err{color:#b91c1c;margin-top:8px}</style></head>
<body>
<h2>Memory Block Square Connector</h2>
<p>Enter the connector secret to authorize this app.</p>
<form method="POST" action="/authorize">
<input type="hidden" name="client_id" value="${client_id || ""}">
<input type="hidden" name="redirect_uri" value="${redirect_uri}">
<input type="hidden" name="state" value="${state || ""}">
<input type="hidden" name="code_challenge" value="${code_challenge || ""}">
<input type="hidden" name="code_challenge_method" value="${code_challenge_method || ""}">
<input type="password" name="secret" placeholder="Connector secret" autofocus required>
<button type="submit">Authorize</button>
</form>
</body></html>`);
  });

  app.post("/authorize", express.urlencoded({ extended: true }), (req, res) => {
    const { redirect_uri, state, code_challenge, code_challenge_method, secret } = req.body;
    if (secret !== CONNECTOR_SECRET) {
      res.status(401).send("Incorrect secret. Go back and try again.");
      return;
    }
    const code = randomUUID();
    authCodes.set(code, {
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || "plain",
      expires: Date.now() + 5 * 60 * 1000,
    });
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.post("/token", express.urlencoded({ extended: true }), (req, res) => {
    const { grant_type, code, redirect_uri, code_verifier } = req.body;
    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    const entry = authCodes.get(code);
    if (!entry || entry.expires < Date.now()) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    authCodes.delete(code); // one-time use

    if (entry.redirectUri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    if (entry.codeChallenge) {
      const expected =
        entry.codeChallengeMethod === "S256"
          ? base64url(createHash("sha256").update(code_verifier || "").digest())
          : code_verifier;
      if (expected !== entry.codeChallenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    // The access token IS the connector secret - the existing /mcp bearer check
    // already accepts it, so no separate token validation path is needed.
    res.json({
      access_token: CONNECTOR_SECRET,
      token_type: "Bearer",
      expires_in: 315360000, // ~10 years; there's no refresh flow, so keep this long
    });
  });
}
