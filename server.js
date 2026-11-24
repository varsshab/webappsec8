const express = require("express");
const path = require("path");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const saved = [
  {
    url: "https://example.edu/robotics",
    title: "Robotics club",
    snippet: "Shop hours, ride board, and the missing hex-driver thread."
  },
  {
    url: "https://example.edu/film",
    title: "Film society",
    snippet: "Thursday screening in the basement theater. Bring a chair."
  }
];

function extract(html) {
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1].trim();
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    title: title || text.slice(0, 60) || "Untitled",
    snippet: text.slice(0, 240)
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/internal", (_req, res) => {
  res.type("text/plain").send(
    "Desk note. Not for the public preview list. Release code PREVIEW-4418. Rotate after the spring screening."
  );
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});



const dns = require("dns").promises;
const net = require("net");

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) {
      const mapped = v.slice(7);
      return net.isIPv4(mapped) ? isPrivateIp(mapped) : true;
    }
    return /^(fc|fd|fe[89ab])/.test(v);
  }
  return true;
}

function blocked() {
  const err = new Error("blocked");
  err.code = "BLOCKED";
  return err;
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw blocked(); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw blocked();
  if (u.username || u.password) throw blocked();
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw blocked();
  return u;
}

async function safeFetch(rawUrl) {
  let current = rawUrl;
  for (let i = 0; i < 4; i++) {
    const u = await assertPublicUrl(current);
    const response = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    const loc = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && loc) {
      current = new URL(loc, u).toString();
      continue;
    }
    return response;
  }
  throw blocked();
}

async function readLimited(response, max = 500000) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= max) { await reader.cancel(); break; }
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, max);
}



app.post("/preview", async (req, res) => {
  const url = String(req.body.url || "").trim();
  if (!url) {
    return res.status(400).send(page("Paste a URL.", saved, null));
  }
  try {
    const response = await safeFetch(url);
    const body = await readLimited(response);
    const card = { url, ...extract(body), status: response.status };
    res.send(page(null, saved, card));
  } catch (err) {
    if (err.code === "BLOCKED") {
      return res.status(400).send(page("That address is not allowed.", saved, null));
    }
    res.status(502).send(page("Could not fetch that URL.", saved, null));
  }
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(error, cards, fresh) {
  const list = cards
    .map(
      (card) => `<article class="card"><h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.snippet)}</p><p class="url">${escapeHtml(card.url)}</p></article>`
    )
    .join("");
  const result = fresh
    ? `<article class="card fresh"><p class="status">${fresh.status}</p><h2>${escapeHtml(fresh.title)}</h2><p>${escapeHtml(fresh.snippet)}</p><p class="url">${escapeHtml(fresh.url)}</p></article>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Preview</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="shell">
    <header class="top">
      <a class="brand" href="/"><span class="mark">Pv</span><span><strong>Preview</strong><em>Club link cards</em></span></a>
    </header>
    <main>
      <section class="hero">
        <h1>Paste a club URL. Get a card.</h1>
        <p class="lede">Preview fetches the page and keeps the title and the first lines. No account required.</p>
      </section>
      <form method="post" action="/preview" class="stack">
        <label><span>URL</span><input name="url" type="url" placeholder="https://..." required></label>
        <button type="submit">Preview</button>
      </form>
      ${error ? `<p class="flash">${escapeHtml(error)}</p>` : ""}
      ${result}
      <h2 class="section">Saved cards</h2>
      ${list}
    </main>
    <footer>Preview is unofficial. It only reads what the URL returns.</footer>
  </div>
</body>
</html>`;
}

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Preview listening on ${port}`);
});
