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
- **Timeline stats** — self/teammate healing, healing and regeneration by source, damage taken,
  mitigation, barrier absorption, and creep/objective damage.
- **Lane phase** — recorded starting assignments, individual/pair totals, and
  an adjustable cutoff. Uses the previous summary sample, without interpolation.
- **Dark / light themes.**

## Tech stack

- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite 6](https://vite.dev/) + [Tailwind CSS 4](https://tailwindcss.com/)
- [Bun](https://bun.sh/) (package manager + script runner)
- [boon](https://github.com/pnxenopoulos/boon) 0.16 (Rust), published on crates.io and compiled to
  WebAssembly with [`wasm-pack`](https://github.com/rustwasm/wasm-pack)

## Performance and memory

The WASM adapter uses Boon 0.16 and pbdems2 0.4.0. It requests only the event
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

Normal builds use Boon's published checkpoint API. Demo loading prepares
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
