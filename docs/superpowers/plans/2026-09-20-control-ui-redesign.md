# Control UI Visual Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the generic dark-admin look of `web/control/` with a distinctive, designed operator console — same features, same security invariants — verified by screenshots at 390px and 1280px.

**Architecture:** Pure CSS/DOM changes under `web/control/` plus two self-hosted font files. No new runtime dependencies, no framework, no CDN. Views keep building the DOM through `h()` text nodes; the only new helper is an SVG icon builder that uses `createElementNS` with a static path table (no markup strings, no innerHTML). CSP gains `font-src 'self'`; `static.ts` gains the `.woff2` MIME type.

**Tech Stack:** vanilla ES modules, CSS custom properties, `<dialog>` for the mobile "More" sheet, Geist + Geist Mono (OFL 1.1, latin subset, ~52 KB total) served from `/fonts/`.

**Spec:** `docs/superpowers/specs/2026-09-20-control-ui-design.md` §Render boundary (text-node rule, CSP, no inline script/style) — the only change is `font-src 'self'` in the CSP, and the spec's header block is updated in the same commit.

## Design direction (decided; user asked for a non-template look and delegated the choice)

Name: **"Console"** — chroma only for meaning.

- **Palette (dark default; contrast verified in Task 4 Step 2):** warm near-black surfaces `--bg #0a0a0b`, `--surface #131316`, `--surface-2 #1b1b1f`; hairline `--line rgba(255,255,255,.08)`; text `#ededef` / muted `#8d8d95` / faint `#5c5c66`. **No brand hue.** Primary action = `#ededef` on black (`--fg-inverse`). State colours are the only chroma: ok `#3dd68c`, warn `#f5b942`, bad `#f0655c`, info `#6ea8ff`. Light scheme mirrors (bg `#f6f6f7`, surface `#fff`, line `rgba(0,0,0,.09)`, primary `#111` on white). Contrast: muted on surface ≥ 4.6:1, checked in step 1.
- **Type:** Geist 400/500/600 for UI; Geist Mono 400/500 for ids, times, counts, eyebrow labels. Scale 12/13/14/16/20/26. Titles 26px/600, tracking -0.02em. Eyebrows: mono 11px uppercase, tracking .08em, muted. `font-variant-numeric: tabular-nums` on mono.
- **Layout:** desktop = 232px rail + content (max 1040px, 24px gutter). Rail: wordmark, grouped nav — *Operate* (Chat, Sessions, Tasks) / *Configure* (Agents, Wardens, MCPs, Groups, Channels, Memory) — plus a bottom status strip (live dot + version + mode). Active item: `--surface-2` fill + 2px `--fg` left bar. Mobile = bottom bar with **4 tabs + More** (bottom-nav ≤5 rule): Chat, Sessions, Tasks, Agents, More → `<dialog class="sheet">` listing the rest. Page header per view: eyebrow (section group) + title + right-aligned actions.
- **Surfaces:** lists are hairline-separated rows (no per-row bordered cards); cards only for the Agents/Wardens/MCPs grids, with `--surface` fill, no border, 12px radius, 1px inset highlight on hover. Tables lose the outer border and use hairline row dividers.
- **Chat as a document:** no bubbles. User turn = right-aligned compact `--surface-2` block, max 72ch. Assistant turn = full-width prose with a mono "Deus" eyebrow; tool calls = collapsible rows with a mono `tool · name` label and a 2px left rule; live turn shows a pulsing dot in the eyebrow. Composer = single rounded container with the textarea and a circular icon send button; Stop replaces Send while streaming.
- **Icons:** 18px Lucide-style stroked SVGs (1.5px, round caps) from a static `ICONS` path table in `web/control/icons.js`; built with `createElementNS` — never markup strings.
- **Motion:** view enter `fade + translateY(4px)` 160ms ease-out; live dot pulse 1.6s; all disabled under `prefers-reduced-motion`.
- **Login:** centred column, wordmark + one-line hint, input + full-width primary button, hairline rule above the error line — no card box.

## Global Constraints

- DOM from API data enters only through `h()` text nodes or `textContent` (spec §Render boundary). `icons.js` takes only keys from its own static table.
- No inline `style=`/`<style>`/`<script>`; CSP stays `default-src 'none'` with explicit sources; fonts add `font-src 'self'` only.
- No CDN, no external requests; fonts are files in `web/control/fonts/` with `OFL.txt` beside them.
- Touch targets ≥ 44px; body text ≥ 15px mobile; no horizontal page scroll at 375px.
- Public-repo generic: no instance names/paths in files or PNGs; screenshots use the synthetic fixture with `assistantName: 'Deus'`.
- Every tab's existing test selectors (`.card`, `table`, `.row`, `.memory-item`, `.memory-content`, `.msg.assistant`, `.composer-input`, `.composer-actions .primary`) keep working, or the screenshot script is updated in the same task.

---

### Task 1: Fonts, MIME, CSP, icon helper

**Files:**
- Create: `web/control/fonts/Geist-latin.woff2`, `web/control/fonts/GeistMono-latin.woff2`, `web/control/fonts/OFL.txt` (latin subsets downloaded once from Google Fonts' gstatic host — Geist is OFL 1.1 — and the license text from the Geist repo's `LICENSE.txt`; the files are committed, nothing is fetched at runtime)
- Modify: `src/control-ui/static.ts` (`TYPES` + `'.woff2': 'font/woff2'`; CSP `font-src 'self'`)
- Modify: `src/control-ui/static.test.ts` (assert woff2 MIME and the `font-src 'self'` directive)
- Create: `web/control/icons.js`
- Modify: `web/control/sw.js` (cache name `deus-control-v4`, add `/icons.js` and both font files to SHELL)
- Modify: `web/control/icons/icon.svg`, regenerate `icon-192.png`/`icon-512.png` via `scripts/control-ui-icons.mjs`, and `web/control/manifest.webmanifest` (`background_color`/`theme_color` → `#0a0a0b`) so the installed-app icon and splash use the new tokens
- Modify: `docs/superpowers/specs/2026-09-20-control-ui-design.md` (CSP string gains `font-src 'self'`)

**Interfaces:**
- Produces: `icon(name, {size=18, label})` → `SVGElement` with `aria-hidden` unless `label` given; names: chat, sessions, tasks, agents, wardens, mcps, groups, channels, memory, more, send, stop, plus, refresh, trash, play, pause, check, x, alert, chevron, search, logout.

- [ ] Step 1: Copy font files + OFL.txt; add `.woff2` to `TYPES`; add `font-src 'self'` after `style-src 'self'` in `SECURITY_HEADERS`.
- [ ] Step 2: Test in `static.test.ts`: `expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("font-src 'self'")` and a request for `/fonts/Geist-latin.woff2` returns `font/woff2`. Run `npx vitest run src/control-ui/static.test.ts` → pass.
- [ ] Step 3: Write `icons.js`:

```js
const NS = 'http://www.w3.org/2000/svg';
const ICONS = { chat: ['M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z'], /* one entry per name, 24-unit viewBox */ };
export function icon(name, { size = 18, label } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || ICONS.more) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
```

- [ ] Step 4: Bump sw cache name; add new shell files. Run `npx tsc --noEmit -p tsconfig.json` and `npx eslint src/control-ui`.

### Task 2: Tokens, base styles, shell (index.html + app.css + app.js)

**Files:**
- Modify: `web/control/index.html` (login column; rail with grouped `<nav>`; status strip; `#more` sheet dialog; `<link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/Geist-latin.woff2">`; theme-color `#0a0a0b`)
- Rewrite: `web/control/app.css` (tokens, @font-face ×2 with `font-display: swap`, base, login, rail, tabbar, sheet, page header, lists, cards, tables, badges, forms, dialog, toast, motion, light scheme, reduced-motion)
- Modify: `web/control/app.js` (VIEWS gain `group: 'Operate'|'Configure'` and `icon` keys; `navItems()` renders rail groups; tabbar renders 4 primary + More; More opens `#more` dialog with the remaining views; `route()` closes the sheet; page-header helper `header(title, {eyebrow, actions})` exported for views)

- [ ] Step 1: `app.css` `:root` tokens exactly as in the direction above; `@font-face` for Geist (weight 100 900, variable) and Geist Mono (weight 100 900).
- [ ] Step 2: Shell CSS: `.app` grid `232px 1fr` at ≥768px; rail sticky 100dvh; `.nav-group` eyebrow + links with icon + label; `.rail-foot` status strip; `.tabbar` fixed bottom, 5 equal cells, icon over 11px label, safe-area padding; `.sheet` dialog bottom-anchored on mobile (`margin: auto 0 0`, full width, 16px top radius) with list of remaining views.
- [ ] Step 3: `app.js`: VIEWS metadata; `MOBILE_PRIMARY = ['chat','sessions','tasks','agents']`; `navItems(group)`; `moreItems()`; `#more` open/close; `header()` helper; brand text stays `${assistant} · Control`.
- [ ] Step 4: Smoke: build, run fixture on 3129, open in Playwright at 390 and 1280, assert `document.body.scrollWidth <= innerWidth` on mobile and the tabbar has exactly 5 anchors/buttons.

### Task 3: Views — chat as a document, page headers, rows, cards, forms

**Files:**
- Modify: `web/control/views/chat.js` (turn structure: `.turn.user` / `.turn.assistant` containing `.eyebrow` + `.body`; keep `.msg` classes as aliases so the screenshot selector `.msg.assistant:not(.live)` still works — i.e. class `turn msg assistant`; composer: container `.composer` with textarea + icon buttons; Stop swaps in for Send)
- Modify: `views/agents.js`, `wardens.js`, `mcps.js` (use `header()`; card `.title` gets a mono model badge; chips → `.tag` mono)
- Modify: `views/sessions.js`, `groups.js`, `tasks.js`, `channels.js`, `memory.js` (use `header()`; `.row` keeps class; task form uses `.field` labels with mono hints; channels status uses dot+label badge; memory tree items get folder/file icons)
- Modify: `web/control/app.css` (chat, rows, cards, tags, forms, memory, tasks, channels sections)

- [ ] Step 1: Chat: rewrite `bubble()` → `turn(role, text, {live})`; assistant eyebrow reads the assistant name from `me.assistant`; tool rows `details.tool > summary(mono 'tool · name') + pre`.
- [ ] Step 2: Replace each `h('h1', …)` with `header(...)` from app.js; keep all existing ids/classes used by tests and the screenshot script (`.composer-input`, `.composer-actions .primary`, `.card`, `table`, `.row`, `.memory-item`, `.memory-content`).
- [ ] Step 3: CSS for the above. Badges: `.badge` = inline-flex, mono 11px uppercase, `::before` 6px dot in the state colour, text in `--text` (colour is never the only carrier — the label already names the state).
- [ ] Step 4: Run `npx vitest run src/control-ui` (server tests are DOM-independent — expected unchanged) and `npx eslint web/control --no-eslintrc --parser-options=ecmaVersion:2022,sourceType:module` is NOT configured; instead `node --check` each JS file.

### Task 4: Screenshot iteration + record

**Files:**
- Modify: `scripts/control-ui-screenshot.mjs` (channels step clicks "Show pairing QR", types the confirmation and waits for `.qr`; a `more` pseudo-tab captures the open sheet on mobile; login capture before signing in)
- Create: `docs/control-ui/artifacts/v2-{login,chat,agents,sessions,tasks,channels,memory}-{mobile,desktop}.png` and `v2-more-mobile.png` (the sheet exists only below 768px; the rail shows everything on desktop)
- Modify: `docs/control-ui-notes.md` (new "Visual redesign (v2)" section: direction, tokens, a11y checks with numbers, PNG list, deviations), `docs/control-ui-progress.md`

- [ ] Step 1: Capture; view every PNG; fix what looks wrong; recapture. Loop until: no clipped tabbar labels, no horizontal scroll, chat composer visible above the tabbar on mobile, QR visible, sheet visible, and no instance names/paths/jids anywhere in the PNGs (same review Phases 1–3 recorded).
- [ ] Step 2: Contrast check with a small node script over the token pairs (text/surface, muted/surface, primary/inverse, each state colour on surface as a 3:1 graphic) — record ratios in the notes.
- [ ] Step 3: Update notes/progress; run the full quality gate (`npx vitest run src/control-ui src/db`, tsc, eslint, prettier on staged .ts); stage; code-reviewer + verification-gate; commit as `feat(control-ui): redesign the dashboard as a monochrome operator console (v2)`.

## Self-review

- Spec coverage: render boundary (Task 1 icons + Global), CSP (Task 1), PWA shell (Task 1 sw), mobile-first (Task 2), screenshot record (Task 4).
- Placeholders: none — every step names files, classes and commands.
- Type consistency: `icon()`, `header()` names used identically in Tasks 1–3.
