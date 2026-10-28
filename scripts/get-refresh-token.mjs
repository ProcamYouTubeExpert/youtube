#!/usr/bin/env node
// One-time helper: the channel owner signs in with Google and this prints the
// refresh token to store as the GitHub secret GOOGLE_REFRESH_TOKEN.
//
// Needs an OAuth client of type "Desktop app" from Google Cloud Console.
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.mjs

import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim();
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first, e.g.\n" +
    "  GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com GOOGLE_CLIENT_SECRET=yyy node scripts/get-refresh-token.mjs");
  process.exit(1);
}

const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const expectedState = b64url(randomBytes(16));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/") {
    res.writeHead(404).end();
    return;
  }
  const finish = (status, message) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>YouTube dashboard</title><p style="font:16px system-ui;margin:40px">${message}</p>`);
    server.close();
  };

  if (url.searchParams.get("error")) {
    finish(400, "Sign-in was cancelled. You can close this tab.");
    console.error(`Sign-in failed: ${url.searchParams.get("error")}`);
    process.exitCode = 1;
    return;
  }
  if (url.searchParams.get("state") !== expectedState) {
    finish(400, "Unexpected response. Please run the script again.");
    process.exitCode = 1;
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code"),
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      throw new Error(tokens.error_description || tokens.error || "Google did not return a refresh token.");
    }

    const chRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const ch = (await chRes.json()).items?.[0];

    finish(200, "Done. You can close this tab and go back to the terminal.");
    console.log("\nSigned in successfully.");
    console.log(ch ? `Channel: ${ch.snippet.title} (${ch.id})` : "Warning: this Google account has no YouTube channel. Run again and pick the Procam channel.");
    console.log("\nAdd this as the GitHub secret GOOGLE_REFRESH_TOKEN:\n");
    console.log(tokens.refresh_token);
    console.log("");
  } catch (err) {
    finish(500, "Something went wrong. Check the terminal for details.");
    console.error(`Token exchange failed: ${err.message}`);
    process.exitCode = 1;
  }
});

let redirectUri;
server.listen(0, "127.0.0.1", () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    state: expectedState,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  console.log("Opening your browser to sign in. Choose the Google account that manages the Procam YouTube channel,");
  console.log("and if asked, pick the Procam channel itself. If the browser doesn't open, visit:\n");
  console.log(authUrl.toString() + "\n");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${opener} "${authUrl.toString()}"`);
});
