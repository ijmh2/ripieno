#!/usr/bin/env node
/**
 * The site: one hand-authored front page, and documents rendered from the
 * documents.
 *
 * A website is a second place for setup instructions to live, and a second copy
 * of a command is how one of them ends up wrong — the same reasoning that keeps
 * the path checks in a single module. So no *instruction* is written twice:
 * every documentation page is rendered from the markdown already in the
 * repository, and this script owns only the wrapper around it.
 *
 * The front page is the exception, deliberately — see PAGES below. It holds no
 * setup commands of its own, only links to the pages that own them, so the rule
 * survives intact.
 *
 * Output is plain static files with no runtime and no external requests, so it
 * hosts anywhere: GitHub Pages, Cloudflare Pages, Netlify, or a bucket.
 *
 *   npm run site          build into site/dist
 *   npm run site -- --serve   build and serve on :4173
 */

const fs = require("node:fs");
const path = require("node:path");
const MarkdownIt = require("markdown-it");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "site", "dist");

/**
 * Every *document* page, in nav order. `source` is the file that owns the words
 * and nothing here may restate them.
 *
 * The landing page is deliberately not in this list. A README is written for
 * somebody already at the repository deciding whether to use the thing; a front
 * page is for somebody who arrived from a link with no context at all, and
 * rendering the first as the second gives a wall of prose where a door should
 * be. It is hand-authored in site/index.html, and it carries no setup commands
 * — only links to the pages that own them — so there is still nothing that can
 * drift.
 */
const PAGES = [
  { slug: "overview", source: "README.md", nav: "Overview", title: "Overview" },
  {
    slug: "self-hosting",
    source: "docs/self-hosting.md",
    nav: "Run a relay",
    title: "Running your own relay",
  },
  { slug: "provenance", source: "docs/provenance.md", nav: "Provenance", title: "Provenance" },
  { slug: "mcp", source: "docs/mcp.md", nav: "MCP", title: "MCP" },
  { slug: "privacy", source: "PRIVACY.md", nav: "Privacy", title: "Privacy" },
  { slug: "security", source: "SECURITY.md", nav: "Security", title: "Security" },
  { slug: "support", source: "SUPPORT.md", nav: "Support", title: "Support" },
];

const BY_SOURCE = new Map(PAGES.map((page) => [page.source, page]));

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

/**
 * Point in-repo links at their rendered page.
 *
 * The markdown links to sibling files — `[SUPPORT.md](SUPPORT.md)` — which is
 * correct on GitHub and a 404 here. Anything not in PAGES keeps its original
 * target and resolves against the repository, so a link to a source file still
 * goes somewhere real rather than being silently dropped.
 */
function rewriteHref(href, repoUrl) {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;
  const [filePart, hash = ""] = href.split("#");
  const clean = filePart.replace(/^\.\//, "");
  const page = BY_SOURCE.get(clean);
  if (page) return `${page.slug}.html${hash ? `#${hash}` : ""}`;
  if (/^docs\/images\//.test(clean)) return clean;
  if (clean === "") return hash ? `#${hash}` : "#";
  return `${repoUrl}/blob/main/${clean}${hash ? `#${hash}` : ""}`;
}

function render(source, repoUrl) {
  const raw = fs.readFileSync(path.join(ROOT, source), "utf8");
  const tokens = md.parse(raw, {});
  for (const token of tokens) {
    if (token.type !== "inline" || !token.children) continue;
    for (const child of token.children) {
      if (child.type === "link_open") {
        const href = child.attrGet("href");
        if (href) child.attrSet("href", rewriteHref(href, repoUrl));
      }
      if (child.type === "image") {
        const src = child.attrGet("src");
        if (src) child.attrSet("src", rewriteHref(src, repoUrl));
      }
    }
  }
  // The README opens with an <h1> and a <picture>; the template supplies neither,
  // so the body is rendered exactly as written.
  return md.renderer.render(tokens, md.options, {});
}

function layout({ title, body, slug, description }) {
  const nav = PAGES.map((page) => {
    const current = page.slug === slug ? ' aria-current="page"' : "";
    return `<a href="${page.slug}.html"${current}>${page.nav}</a>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<link rel="stylesheet" href="site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="wordmark" href="./">Ripieno</a>
  <nav aria-label="Documentation">${nav}</nav>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <p>Source-available, free for personal and internal use. Not open source.</p>
  <p>Built by Ivan Hart. This page is generated from the repository's own
  markdown — there is no second copy of anything here.</p>
</footer>
</body>
</html>
`;
}

function firstParagraph(html) {
  const match = html.match(/<p>([\s\S]*?)<\/p>/);
  const text = (match?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text.slice(0, 180).replace(/"/g, "&quot;");
}

function copyImages() {
  const from = path.join(ROOT, "docs", "images");
  if (!fs.existsSync(from)) return 0;
  const to = path.join(OUT, "docs", "images");
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const file of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
    n += 1;
  }
  return n;
}

function build() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const repoUrl = "https://github.com/ijmh2/ripieno";

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const page of PAGES) {
    const source = path.join(ROOT, page.source);
    if (!fs.existsSync(source)) {
      console.warn(`  skipped ${page.source} (not found)`);
      continue;
    }
    const body = render(page.source, repoUrl);
    const html = layout({
      title: `${page.title} — Ripieno`,
      description: firstParagraph(body) || pkg.description || "Ripieno",
      body,
      slug: page.slug,
    });
    fs.writeFileSync(path.join(OUT, `${page.slug}.html`), html);
    console.log(`  ${page.source.padEnd(24)} -> ${page.slug}.html`);
  }

  for (const asset of ["site.css", "landing.css", "index.html"]) {
    fs.copyFileSync(path.join(ROOT, "site", asset), path.join(OUT, asset));
  }
  console.log("  site/index.html".padEnd(26) + "-> index.html (hand-authored)");
  const images = copyImages();
  // Tells GitHub Pages not to run Jekyll, which would drop files beginning "_".
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

  const domain = process.env.RIPIENO_SITE_DOMAIN?.trim();
  if (domain) {
    fs.writeFileSync(path.join(OUT, "CNAME"), `${domain}\n`);
    console.log(`  CNAME -> ${domain}`);
  }

  console.log(`\n  ${PAGES.length} pages, ${images} images -> site/dist`);
}

function serve(port) {
  const http = require("node:http");
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
  };
  http
    .createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0];
      let file = path.join(OUT, url === "/" ? "index.html" : decodeURIComponent(url));
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      // Never serve outside the built site, whatever the request says.
      if (!file.startsWith(OUT) || !fs.existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    })
    .listen(port, "127.0.0.1", () => console.log(`\n  serving http://127.0.0.1:${port}\n`));
}

build();
if (process.argv.includes("--serve")) serve(Number(process.env.PORT ?? 4173));
