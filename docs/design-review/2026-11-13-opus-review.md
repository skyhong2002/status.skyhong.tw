# Design review — 2026-11-13

- Reviewer: Claude Opus 5.5 (claude-proxy, effort high), screenshots only — no source code.
- Input: 20 full-page screenshots of `main` at 411d6c9, served by `scripts/preview_server.mjs` with fabricated data (no probes, no alerts): states `operational`, `degraded`, `outage`, `incident`, `nodata` × widths 1440 / 390 × light / dark.
- Brief: compare with Kener, Gatus, Atlassian Statuspage; score 1–10, strengths to keep, top five problems.

The review below is the reviewer's text, unedited.

---

I've looked at all 20 screenshots, plus close-up slices of the tall pages. Here is the review.

# Status page review: screenshots in `/tmp/status-shots/before/`

## 1. Score: 6/10

The parts underneath are good. The uptime rows (bars, latency, 30-day %) are as dense as Gatus or Kener. Problem items rise to the top. Dark mode matches light mode, and the attention list only appears when something is wrong. What holds the score down is the top of the page, which is what a status page is judged on. It doesn't say how bad things are: degraded and outage look the same. It doesn't say since when: no item has a start time. And in one state it shows green when nothing has been checked. Statuspage and Better Stack get these three right in the first 300px. The rest is polish.

## 2. Keep

- **Attention list only when needed.** It sits above the detail sections and disappears when everything is healthy (`operational-*`). This is better than a permanent "Incidents" block.
- **Rows that answer three questions at once.** Name, the actual error ("connect ETIMEDOUT · host unreachable"), 24 h bars, latency, 30-day uptime and a status pill all fit on one desktop row.
- **Failing items sorted first inside their cards.** `dokploy-traefik` and `plaud-api` lead their lists, and the 12-day cert leads the TLS list (`degraded-1440-dark`).
- **One-line section explainers.** "Each job pings in on schedule; silence is an incident" teaches the model without needing docs.
- **Expiry rows.** A bar plus a day count, sorted by soonest. Easy to scan.
- **Dark mode.** It is a real theme, not an inverted one, and the status colours stay distinct.
- **Masked account emails and the footer links** (RSS, Badge, Metrics).

## 3. Top 5 problems

### 1. The no-data state shows a false green
**What I see:** `nodata-*` shows "All systems operational", "Last check 1/1/1970, 8:00:00 AM", and "Loading…" with a green dot in the header. The Jobs and AI gateway sections are missing, but their nav links are still there. The products block says "No public targets configured", which isn't true: they haven't been checked yet.

**Why it matters:** A status page that says green without evidence is worse than having no page.

**Fix:**
- When there is no check timestamp (or it is ≤ 0), show a neutral grey hero: "Waiting for first checks", with the subtitle "Monitoring just started; results appear within a minute."
- Hide "Last check" in that state.
- Use a grey dot in the header, not green.
- Change the empty-state copy to "Not checked yet".
- Hide the nav links for sections that aren't rendered.

### 2. The hero and summary tiles don't show how bad things are
**What I see:**
- `degraded-1440-light` has only amber items (two slow services and a cert). It still gets the same red dot, red gradient and "3 items need attention" as `outage-1440-light`, which has a product actually down.
- The tiles seem to be coloured by ratio, not by the worst item. In outage, Public endpoints shows "10/11" in amber even though a product is down. In incident, Docker shows "11/12" in amber while the reverse proxy is down.
- In degraded, the tile says "11/11" green while the table below says "6/8 operational".

**Why it matters:** Visitors decide from colour plus headline. Statuspage-style levels (Degraded / Partial outage / Major outage) exist for exactly this.

**Fix:**
- Base the hero colour and headline on the worst item. Amber: "Degraded performance — 2 slow, 1 cert expiring". Red: "Partial outage — plaud.observe.tw down". Use "Major outage" when ≥ 3 items are down.
- Colour each tile by its worst member.
- Count slow items separately in the tile, e.g. "11/11 · 2 slow".

### 3. No "since when"
**What I see:**
- No attention card in `outage-*` or `incident-*` has a start time or duration.
- The hero only shows an absolute "Last check 11/13/2026, 2:20:55 AM".
- The phone layout drops the "Updated just now" indicator entirely (`*-390-*`).

**Why it matters:** "Is it new, or has it been down all night?" is the second question every visitor asks.

**Fix:**
- Replace the grey "View →" on each attention card with a right-aligned "since 01:52 · 28 min". Derive it client-side from the first consecutive non-up bar in the existing 24 h history. For agent items, use the last-report timestamp.
- Make the whole card the link.
- Change the hero line to a relative time ("Checked 12 s ago") with the absolute time in a tooltip.
- Show it on phone too, under the headline.

### 4. The incident list is flat and repeats itself, and the table numbers mislead
**What I see:**
- `incident-1440-light`: 11 cards at the same weight. Five are the identical "connect ETIMEDOUT · host unreachable", next to `dokploy-traefik` "port 443 already in use", which is probably the cause.
- The product table only starts after about 1.1 screens on desktop and about 2 on phone.
- Unavailable rows show "12,000 ms" response and "100%" 30-day uptime next to a red pill.

**Fix:**
- Group attention items that share the same error text into one expandable card: "5 products unreachable — connect ETIMEDOUT".
- Sort infrastructure-level failures (proxy, host agent) first.
- Show at most 5 cards plus "Show N more".
- Show "Timeout" instead of a timeout-cap latency.
- Never round uptime up to 100% when the window has any downtime: floor to two decimals, e.g. "99.98%".

### 5. The phone layout wastes height and drops context
**What I see:** In `*-390-*`:
- The status pill sits on its own line under the bars, so each product row is about 125px tall. The page is about 6,700–7,400px.
- Latency and uptime are hidden.
- The section nav is gone.
- There are 24 bars instead of 48, but the legend still says "Last 24 h, 30 min per bar".

**Fix:**
- Put the pill on the same line as the name, right-aligned, with "99.93%" in small text under it.
- Either draw 48 thinner bars (about 5px bar plus 2px gap fits in 336px) or change the legend to match what is shown.
- Add a horizontally scrolling sticky bar of section chips under the header, each with a coloured dot for that section's worst state.

## 4. Nits

- **Too many status words.** There are 12 pill labels (Operational, Running, On time, Serving, Mapped, Valid, Answered, Verified, Unverified, Unavailable, Down, Stale). "Stale" is grey in one place and red in another (`incident-1440-light-04`). Use one set of colours for OK / Warn / Down / Unknown and keep the specific word as secondary text.
- **Low-contrast green pills.** "Running" and "On time" are grey-green text on pale green, which looks below 4.5:1, especially in dark mode.
- **Truncation where there's space.** On desktop, "Discord returned 429 Too Many R…" and "6.8 s exceeds the 5 s thre…" are cut off even though the row has room. Let the text wrap.
- **Severity mismatch.** Alert delivery is an amber card in the attention list but shows a red "Unverified" pill and a red "0/1" in its own section. The 12-day cert's "8/9" header is red while its bar is amber.
- **Orange labels compete with status colours.** The orange small-caps section labels ("ATTENTION", "EXTERNAL PROBES") sit close to the warning amber. Use a neutral colour for them.
