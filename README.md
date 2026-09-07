# Ratings Lab

Table tennis analysis for Ratings Central CSV exports. Two pages: player history,
and head to head. Everything runs in the browser — no server, no account, no
database, no stored copy of anyone's file.

## Run it locally

    npm install
    npm run dev

Open the address it prints, usually http://localhost:5173

    npm run build      # writes dist/
    npm run preview    # serves dist/ so you can check the real build

## Deploy it free

All three options below are free for a project this size, serve over HTTPS
automatically, and cost nothing to run because there is no backend.

### Cloudflare Pages — recommended

1. Push this folder to a GitHub repository.
2. Go to dash.cloudflare.com, then Workers & Pages, then Create, then Pages,
   then Connect to Git.
3. Pick the repository. Set:
   - Framework preset: Vite
   - Build command: `npm run build`
   - Output directory: `dist`
4. Save and deploy. You get `yourproject.pages.dev`, and every push rebuilds.

Cloudflare reads `public/_headers`, so the security headers below apply
automatically. Add a custom domain later under the project's Custom domains tab.

### Netlify

1. Push to GitHub.
2. app.netlify.com, Add new site, Import an existing project, pick the repo.
3. `netlify.toml` already sets the build command and publish directory, so accept
   the defaults and deploy.

Netlify also reads `public/_headers`.

### GitHub Pages

1. Push to GitHub.
2. Settings, Pages, Source: GitHub Actions.
3. Add `.github/workflows/deploy.yml` (see below) and push. The site appears at
   `https://<user>.github.io/<repo>/`.

`base: "./"` in vite.config.js keeps asset paths relative, so the subfolder URL
works without further changes. Note that **GitHub Pages ignores `_headers`** — it
does not let you set custom response headers. The app is still safe, but you lose
the Content-Security-Policy. If that matters to you, use one of the other two.

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push: { branches: [main] }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: github-pages
    steps:
      - uses: actions/deploy-pages@v4
```

## About the security headers

`public/_headers` sets a Content-Security-Policy with `connect-src 'none'`. That
tells the browser the page may not open a network connection to anywhere, ever.
Since the app only reads files through the FileReader API, nothing breaks — and
it means the privacy claim on the page is enforced by the browser rather than
being something visitors have to take on trust.

Also set: `frame-ancestors 'none'` and `X-Frame-Options: DENY` so the app cannot
be embedded in someone else's page, `Referrer-Policy: no-referrer` so clicking
through to Ratings Central does not tell them where the visitor came from, and
`nosniff` plus HSTS.

### One external request

The stylesheet imports two typefaces from Google Fonts, which is the only thing
that leaves the visitor's browser. If you want a site that makes zero third-party
requests, self-host them: download Barlow Condensed and IBM Plex Sans, put the
woff2 files in `public/fonts/`, replace the `@import` at the top of the `CSS`
string in `src/App.jsx` with `@font-face` rules, and tighten the policy to
`font-src 'self'; style-src 'self' 'unsafe-inline'`.

## Bundle size

About 620 kB raw, 178 kB gzipped, most of it Recharts. Fine over HTTPS on a
phone. If you want it smaller, import only the Recharts components you use via
deep imports, or lazy-load the head-to-head page with `React.lazy`.
