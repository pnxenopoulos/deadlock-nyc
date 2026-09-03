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
  Mid-Boss, urn spawns, Rift lifecycle), and team-colored chat. Click any row
  to seek.
- **Player detail panel** — health and barrier, abilities, item investments,
  active modifiers, and expanded combat stats including resistances and lifesteal.
- **Dark / light themes.**

## Tech stack

- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite 6](https://vite.dev/) + [Tailwind CSS 4](https://tailwindcss.com/)
- [Bun](https://bun.sh/) (package manager + script runner)
- [boon](https://github.com/pnxenopoulos/boon) (Rust) compiled to WebAssembly
  with [`wasm-pack`](https://github.com/rustwasm/wasm-pack)

## Performance and memory

The WASM adapter uses boon 0.8 and pbdems2 0.3. It requests only the event
types used by the UI and uses boon's changed-entity indices for roster and
objective updates instead of rescanning every live entity each tick.

Parsing runs in a disposable Web Worker. The demo buffer and packed result
columns are transferred rather than cloned, and the worker is terminated after
the parse so its WASM linear memory is returned to the browser. Sampled frames
remain in typed arrays; the UI materializes only the current and next playback
frames, while heatmaps and derived stats scan the compact player columns
directly.

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
changes).

### Build for production

```bash
bun run wasm
bun run build    # tsc -b && vite build → dist/
bun run preview  # serve the production build locally
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
