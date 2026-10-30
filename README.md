# deadlock.nyc

A fast, **fully client-side** demo (replay) viewer for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/),
running entirely in your browser. Drop in a `.dem` file and scrub through the
match on a live minimap — heroes, troopers, jungle camps, breakables, objectives,
Sinner's Sacrifice, the urn, kills, abilities, item builds, and chat.

🔗 **Live:** [deadlock.nyc](https://deadlock.nyc)

Your demo files never leave your machine — parsing happens locally in
WebAssembly, nothing is uploaded.

This tool is powered by [**boon**](https://github.com/pnxenopoulos/boon), a
Deadlock demo parser written in Rust. deadlock.nyc compiles boon to WebAssembly
and renders the parsed entities, events, and stats in the browser.

---

## Features

- **Local-first parsing** — `.dem` files are parsed in-browser via boon (Rust →
  WASM). No server, no upload.
- **Live minimap** with surface / tunnel layers and pan + zoom:
  - Hero dots with team color, portrait, and a facing caret (yaw)
  - Lane troopers, neutral jungle camps, breakable props, and Sinner's Sacrifice
  - Objectives — Guardians, Walkers, Shrines, the Patron, and the Mid-Boss —
    with live health rings
  - The **urn**, tracked through pickups and carries
  - Per-layer toggles for every map overlay
- **Timeline scrubber** with play/pause, back/forward by a configurable step,
  adjustable playback speed, jump-to-tick, and pause-band markers.
- **Keyboard shortcuts** — `Space` play/pause, `←` / `→` back/forward, `Esc`
  to close dialogs.
- **Event feeds** (tabbed) — kills, ability usage, objectives (destructions,
  Mid-Boss, Urn spawns/pickups/drops/returns, Rift lifecycle), and team-colored chat. Click any row
  to seek.
- **Player detail panel** — health and barrier, abilities, item investments, active
  modifiers, current player statuses, ability imbues, and Boon-calculated
  weapon, vitality, spirit, and per-ability stats with input breakdowns.
  Permanent pickup bonuses and counts are indexed for immediate seeking.
- **Live roster state** (the default player tab) with health, barrier, and compact ability cooldowns/charges synced to playback.
- **Timeline stats** — self/teammate healing, healing and regeneration by source, damage taken,
  mitigation, barrier absorption, and creep/objective damage.
- **Lane phase** — recorded starting assignments, individual/pair totals, and
  an adjustable cutoff. Uses the previous summary sample, without interpolation.
- **Dark / light themes.**

## Tech stack

- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite 6](https://vite.dev/) + [Tailwind CSS 4](https://tailwindcss.com/)
- [Bun](https://bun.sh/) (package manager + script runner)
- [boon](https://github.com/pnxenopoulos/boon) 0.19 (Rust), published on crates.io and compiled to
  WebAssembly with [`wasm-pack`](https://github.com/rustwasm/wasm-pack)

## Performance and memory

The WASM adapter uses Boon 0.19 and pbdems2 0.4.1. It requests only the event
types used by the UI and uses boon's changed-entity indices for roster and
objective updates instead of rescanning every live entity each tick.

One Web Worker retains the parser and stat checkpoints for the loaded demo.
The demo buffer and packed result columns are transferred rather than cloned.
Closing or replacing the demo terminates the worker and releases its WASM heap.
Sampled frames remain in typed arrays; the UI materializes only the current and
next playback frames, while heatmaps and derived stats scan the compact player
columns directly.

Player-detail queries use Boon's catalog-byte loaders and single-pass stat
batches. The viewer uses Boon's Deadlock coordinate helpers directly; no
vendored parser or coordinate-origin detection is needed.

Ability history tracks full entity and owner handles, ability IDs, and slots,
so identity changes are recorded even when cooldowns are unchanged. Field keys
are resolved from each demo's serializers, not persisted across parser upgrades.

Replay modifiers and Urn carriers use Boon's shared catalog lifetime rules,
ordered updates, and full-handle validation. No six-player suppression, guessed
Urn pickup, or fixed carry timeout is applied. Untimed Grapple Arm parents remain
unresolved; the viewer does not invent an expiry.

## Getting started

### Prerequisites

- [Bun](https://bun.sh/) (latest)
- A [Rust toolchain](https://rustup.rs/) with the `wasm32-unknown-unknown`
  target and [`wasm-pack`](https://github.com/rustwasm/wasm-pack):

  ```bash
  rustup target add wasm32-unknown-unknown
  cargo install wasm-pack
  ```

### Install & run

```bash
bun install
bun run wasm     # build the boon WASM module → src/wasm/pkg (gitignored)
bun run dev      # start the dev server
```

`src/wasm/pkg` is generated and not committed, so **`bun run wasm` must be run
once before `bun run dev` / `bun run build`** (and again whenever `wasm/src`
or its Cargo dependencies change).

### Stat-query performance checks

Normal builds use Boon's published checkpoint API. With Statuses/modifiers enabled, demo loading prepares
up to 16 exact replay checkpoints once; repeated stat queries resume from the
nearest earlier checkpoint. Recorded statuses are indexed once and update
immediately. Superseded stat requests are coalesced, and recent results are cached.
The viewer selects a bundled catalog matching the demo header (6746 or 6759).
Other builds use the latest bundled snapshot with a mismatch warning.

Compare exact uncached and checkpoint-backed queries on the test demo:

```bash
bun run wasm
bun scripts/benchmark-player-details.ts 111155916.dem
```

### Build for production

```bash
bun run wasm
bun run build    # tsc -b && vite build → dist/
bun run preview  # serve the production build locally
```

With a local test demo, check the browser parser, map coordinates, and player
details using the generated WASM module:

```bash
bun run check-demo -- 111155916.dem 73952
```

## Project structure

```
src/
  components/    React UI (map view, timeline, event log, player detail, …)
  data/          generated game data (item/hero/ability manifests — committed)
  wasm/          WASM glue; pkg/ is built by `bun run wasm` (gitignored)
wasm/            the Rust crate (boon → WASM bindings) compiled by wasm-pack
scripts/         game-data generators (see scripts/README.md)
public/          static assets (item/hero/minimap images, CNAME)
```

## Updating game data

Item icons, hero portraits, rank badges, display names, and the stat panel are
generated from Deadlock's game files. After a patch, refresh them with the pipeline documented
in [`scripts/README.md`](scripts/README.md):

```bash
bun run sync     # pull the latest GameTracking data and regenerate manifests
```

Image and modifier-schema steps require a machine with Deadlock + Source 2
Viewer — see the script docs for details.

## Deployment

The site deploys to GitHub Pages via GitHub Actions
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) on every push to
`main`. The workflow installs Rust + `wasm-pack`, builds the WASM module, runs
`bun run build`, and publishes `dist/`. The custom domain (`deadlock.nyc`) is set
via `public/CNAME`, which serves from the root, so no `base` override is needed.

## Acknowledgements

- **[boon](https://github.com/pnxenopoulos/boon)** — the Rust Deadlock demo
  parser that makes this tool possible.
- [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/) is a game by
  Valve. This is an unofficial, fan-made tool and is not affiliated with or
  endorsed by Valve.

## License

The source code is released under the [MIT License](LICENSE).

Deadlock and all related game content — imagery, icons, minimaps, hero and item
names, and other in-game assets — are the property of Valve Corporation and are
**not** covered by this license. This is an unofficial, fan-made project that is
not affiliated with or endorsed by Valve.


## Win probability

The Timeline view has a **Win probability** switch on its right, off by default.
Before choosing a file, loading options let you enable **Statuses/modifiers** and
**Win probability** independently. Both default off. Basic map playback, recorded
health/barrier, items, and ability cooldowns remain available. Disabled status
loading skips modifier-span materialization, status indexing, and calculated-stat
checkpoints/queries. Minimal modifier transitions still support the Urn and the
recorded barrier pool; recorded permanent pickups remain available.

Disabled panels show an **Enable … and reparse** action. It reparses the same
local file with the requested feature and preserves the selected hero, playback
tick, and timeline selection. The replay loading options button beside playback
settings can enable or disable either option. Status-dependent heatmap metrics,
modifiers, statuses, calculated stats, and ability imbues identify missing data.

When win probability is selected, loading includes its computation and reports
phase/progress before opening the map. It calculates one prediction per active
second, excluding pauses and game-over/post-game states. A compact, clickable
curve appears below the Live teams. The full Timeline chart adds solid objective
lines colored by the destroyed objective's team, dotted deaths colored by the
victim's team, and solid yellow Mid Boss kill lines. Icon toggles above the chart
show or hide player kills, objective kills, and Mid Boss independently. Player
kills start hidden; objectives and Mid Boss start visible. Hover/focus any line
for team-colored victim/owner and killer rows with hero portraits and event icons;
nearby events share a tooltip when lines overlap. The compact Live curve has
matching icon filters and clickable event lines, without event tooltips. Click a
line in either chart to seek to that event.

Both curves reuse the loading result and follow the replay playhead. If an
opted-in model fails, playback still opens with a retry; disabled prediction
requires reparsing rather than silently starting a model job.

Inference runs in the existing Web Worker using ONNX Runtime Web. WebGPU is
preferred where a compatible adapter is available, using batches of four. Missing
GPU support, initialization errors, and shader failures fall back to WASM/CPU
(batches of two). The CPU runtime is loaded separately on devices without a GPU.
Hosts with cross-origin isolation can use up to four CPU threads; GitHub Pages
uses one. All runtime assets are served from the same origin as the site.
The worker reuses the loaded demo/parser and recorded barrier history, extracts
bounded batches, and frees intermediate ML state afterwards. No replay bytes, graph features, or predictions
are sent to a server. Dense graph attention is substantial work: the first full
curve can still take several minutes on a CPU-only/slower device. Progress is
shown throughout loading.

GitHub release binary downloads lack browser CORS headers. Therefore `bun run model`
fetches the latest public release of `pnxenopoulos/deadlock-win-prob`, verifies each
asset digest and the manifest's model/encoder hashes, and writes generated files
to `public/models/win-probability/`. Both `bun run dev` and `bun run build` run this
step. GitHub Pages deployment uses its read-only build token to avoid anonymous
API rate limits; the token is never included in browser code. A site redeploy
picks up a newly released model. The browser checks hashes again before loading
and displays the model version. Models requiring a different parser/schema or
catalog-enriched features fail explicitly rather than inventing inputs.

The browser extractor is matched to Boon 0.19.0 and encoder schema 1, including
recorded teams, world coordinates, inventories, barriers, objective lifetimes,
zipline visibility/control, and the training encoder's missing-value rules.
The original post-match stats and interpolated map frames are not model inputs.

Run the small encoder, lifecycle, and chart tests with `bun test`. A Python-generated
fixture checks normalization, vocabularies, padding, masks, and connectivity.
For a full replay parity check, provide the reference JSON generated by dwp and run:

```bash
bun run wasm
bun scripts/check-win-probability.ts /path/to/match.dem /path/to/reference-folder
```

The reference folder contains `roster.json` and `reference.json` with explicit
ticks, the complete one-second sampling schedule, and dwp-encoded tensors. The
check canonicalizes node order and compares all tensor values against Python.

### Parsing CPU usage

The replay decoder runs on one Web Worker, without a CPU-percentage cap. Replay
entity deltas depend on earlier ticks, so the current decoding pass is serial.
One busy logical core on an eight-logical-core machine can appear as roughly
12.5% aggregate CPU usage; this alone does not show whether the parser is idle.
The Rust/WASM release already uses speed optimization, LTO, and wasm-opt -O3.

Map frames and ML snapshots now share the recorded barrier history, removing a
second full modifier scan without changing feature values. Parallel decoding
would require independent replay/checkpoint partitions or parallel independent
passes; it also increases memory requirements. Shared-memory WASM threading
additionally needs cross-origin isolation, which the current Pages deployment
does not provide. Increasing ONNX CPU threads would affect inference rather
than Boon's ordered replay decoding.
