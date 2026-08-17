# THE MARS TRAIL

*The Oregon Trail* transplanted from 1848 Missouri to 2091 Earth orbit. You captain a
*Conestoga*-class colony transit ship carrying five crew from the Canaveral Orbital Yard to
the Ares Basin colony on Mars — about 225 million kilometres, against a transfer window
that closes in 340 days.

Built with Vite, TypeScript, and vanilla Three.js. All production art, audio, and portraits
are generated through Mint and registered in `mint-assets.json`.

## Run it

```bash
npm install
npm run dev
```

Then open <http://127.0.0.1:5188>.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 5188 |
| `npm run build` | Typecheck, then production build |
| `npm run test:sim` | Headless sim checks — balance harness plus store arithmetic, no browser |
| `npm run test:balance` | Balance harness only — plays 160 full missions |
| `npm run test:store` | Store and sell-back credit arithmetic only |
| `npm test` | Playwright browser checks |
| `npm run test:qa` | Full-playthrough QA — plays a whole mission through the real UI |

## How it plays

Same three-way tension as the original, with the resources renamed and the deadline made
physical:

| Oregon Trail | Mars Trail |
| --- | --- |
| Oxen | **Drive cores** — they wear, overheat, and fail. Load is shared across installed cores, so a six-core ship wears each one far slower than a two-core ship. Cores string out ahead of the hull like a team in harness, and a failed core visibly leaves the line. |
| Food | Rations (kg) |
| Ammunition | Propellant cells |
| Clothing | Rad suits |
| Spare wheel/axle/tongue | Coolant pumps, heat-shield tile sets, comms arrays, hull plates |
| Rivers | **Hazard traversals** — burn through (fast, free, dangerous), creep on thrusters (days + propellant), hire a tug escort (credits), or hold for a clean window (days only) |
| Forts | Orbital stations — everything available, everything marked up, markup rising with distance from Earth |
| Changing your order | Every store row has a `−` and a `+`. At the yard a sell-back refunds in full, because you have not left yet. At a station it returns 45%, so unloading cargo is a real loss and never an arbitrage against the markup. |
| Hunting | **Volatile harvesting** — an EVA aim minigame, capped at 120 kg per run the way the original caps you at 100 lb |
| Winter deadline | **The Hohmann transfer window closing** |
| Dysentery | Radiation sickness, hypoxia, bone-density collapse, space adaptation syndrome, cabin psychosis, hydroponics blight, decompression trauma |

**Five legs**, each opening on a star chart with a branching route choice: shorter and more
dangerous, or longer with a port on the way. Professions keep the original's inverted
difficulty — Corporate Financier starts with 1,100 credits at ×1 score, Terraform
Homesteader with 400 at ×3.

**Win** by reaching Ares Basin with at least one crew member alive. **Lose** to a dead crew,
a closed window, or a ship with no drive cores left.

### Learning it

The home page carries a three-step **How to play** primer covering the only things a new
captain needs before outfitting. **Full briefing** opens the complete tutorial — the two
dials, how to read a crew card, why drive cores are your team, the four ways through a
hazard, where you can stop, and how scoring works. The **Help** button on the travel HUD
reopens it mid-run without losing the mission.

## Architecture

```
src/sim/        Pure TypeScript simulation. No Three.js, no DOM.
                types · content (legs, store, illnesses) · state · tick (the
                attrition engine) · events · hazards · stations · score · index (facade)
src/render/     PixelPipeline + RetroShader — the low-res pixel look
src/scene/      TravelScene, Backdrop, ParallaxLayers, ShipRig, Particulate, palettes
src/assets/     mintRegistry (reads mint-assets.json), GameAssets, gltf-runtime
src/ui/         Hud (persistent travel HUD) · Screens (all modal phases)
src/game/       Game — orchestrator; routes sim phases to surfaces
tests/          sim.balance.ts (headless) · visual.spec.ts (Playwright)
```

The sim owns all state. Rendering and UI read it and call commands; they never mutate it.
Every gameplay roll goes through a seeded RNG, so a seed reproduces a run exactly.

### Travel direction

The hull sits right of centre with its drive cores strung out to the **left** (leading, like a
team in harness) and its exhaust plumes firing **right** (trailing). Every layer therefore
scrolls toward **+x**, so the ship reads as travelling left — the direction its cores lead.
`tests/qa.spec.ts` asserts `scrollX` rises while travelling; an earlier build scrolled the
other way, which flew the ship backwards through its own thrust.

### The pixel-art pipeline

The 2021 Gameloft game was made by modelling and animating in 3D, rendering each frame, then
hand-refining it pixel by pixel. That isn't a real-time pipeline, so this reproduces the same
result in-engine:

1. The scene renders into a **480×270 nearest-filtered buffer**.
2. A chunky bloom pass runs at that resolution.
3. `RetroShader` upscales it with an **ordered-dither palette clamp** (4×4 Bayer), so the
   whole frame reads as one limited colour system instead of gradient banding.
4. Scanlines and vignette are applied on the low-res grid so they scale with the pixel size.

`uPhosphor` swaps the palette clamp for a single-hue CRT-green ramp — the unlockable
monochrome filter, matching the reference game's retro filter. It unlocks after your first
completed run.

Tone mapping is deliberately `NoToneMapping`: the posterise pass owns the frame's value
distribution, and ACES would soften the bands it depends on. Brightness is instead controlled
inside `RetroShader` by `uExposure` (1.6) and `uLift` (0.07), applied **before** quantisation
so the palette steps land on graded values rather than being stretched afterwards. QA samples
mean canvas luminance per leg and holds it in a 28–190 band.

### Balance

`npm run test:sim` plays 160 complete missions across four strategies with no browser and
asserts the model stays in band:

- Cautious, well-supplied play arrives ~93% of the time with about 3 of 5 crew alive.
- Reckless play (two cores, bare rations, always burn through) arrives ~8% and goes adrift
  in most runs.
- Preparation must beat recklessness, or the test fails.

## Generated assets

26 assets across 12 Mint generations, all registered in `mint-assets.json` under stable
logical keys and downloaded to `public/assets/mint/`:

| Key(s) | What |
| --- | --- |
| `ship-hull` | The *Conestoga*-class hull — silhouette deliberately echoes a covered wagon |
| `drive-core` | Fusion-pulse core module, cloned per working core |
| `debris-01…06` | Orbital debris kit: dead comsat, spent stage, torn array, hull section, docking ring, junk cluster |
| `asteroid-01…06` | Asteroid and cometary-ice variants |
| `station-01…05` | LEO Transfer Ring, Lunar Gateway, L1 Waystation, Ceres Depot, Phobos Station |
| `crew-portrait-1…5` | Pixel-art crew busts for the bottom bar |
| `audio-drive-hum` | Looping engine bed, gain tracks the burn rate |
| `audio-klaxon` | Hazard alert |

`scripts/import-mint-manifests.mjs` records the manifests and replays the download and
registry sync, so the asset set is reproducible without re-running agent tooling.

Every GLB loads through the shared Draco-capable loader in `src/assets/gltf-runtime.ts`.
This batch is uncompressed, but a bare `GLTFLoader` cannot decode a Mint-optimized GLB, so
the helper is the only loader path in the project.

## Known gaps

- **Fonts.** The HUD uses a system monospace stack rather than a true bitmap pixel font, to
  avoid a network font dependency. A local `.woff2` pixel face would tighten the match to the
  reference.
- **No animated crew figures.** The reference shows figures walking beside the wagon. Here
  the drive-core team carries that read instead. A rigged crew model with a walk cycle is the
  obvious next asset.
- **Mobile QA not run.** Desktop Chrome specs pass. The `mobile-safari` Playwright project
  exists but has not been executed.

## Load budget

Startup fetches ~2 MB (hull + drive core + code), not the full 24 MB asset set. Prop families
stream in per leg through `GameAssets.ensureFamilies`, and the title screen renders before any
generated asset is required. Crew portraits are 1024px source art displayed at ~40px, marked
`loading="lazy"` and `decoding="async"` so they stay off the first-frame path.

The dev server runs on **port 5188** (`vite.config.ts` pins it with `strictPort`).
`.claude/launch.json` must match, or the preview waits on a port with nothing listening.
#   t h e - m a r s - t r a i l  
 