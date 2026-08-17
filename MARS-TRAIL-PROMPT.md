# Build Prompt — "THE MARS TRAIL"

> Paste everything below the line into a fresh Claude Code session in this folder.
> **Re-attach the 8 Oregon Trail (Switch) screenshots to that message** — they are the
> primary visual reference and I have no hosted URLs for them (see §Reference Material).

---

Use **mint-threejs-skills** to build this Three.js game, with **Mint MCP** as the only
production asset pipeline. Route through the **threejs-game-director**.

## Game Idea

**THE MARS TRAIL** — *The Oregon Trail* transplanted from 1848 Missouri to 2091 Earth
orbit. You are the captain of a *Conestoga*-class colony transit ship carrying a crew of
five from **Cape Canaveral Orbital Yard** to the **Ares Basin colony on Mars** — roughly
225 million kilometres of one-way attrition.

Same soul as the original: a stochastic resource-attrition simulation where every choice
trades one depleting resource for another, and death is arbitrary rather than earned.
`You have died of dysentery` becomes `RADIATION SICKNESS — TERMINAL`.

## Core Verb And Objective

**Verb:** allocate scarce resources across a fixed distance under a hard deadline.
**Objective:** arrive at Mars with crew alive before the transfer window closes.

The three-way tension from the original is preserved exactly:

| Oregon Trail | Mars Trail |
|---|---|
| Food | Rations + reclaimed water |
| Party health | Crew health, energy, hygiene, morale, **accumulated rad dose** |
| Time / winter deadline | **Hohmann transfer window closes** — miss it and Mars is out of position |

## Concept Translation Table

Adapt the rules from <https://oregontrail.ws/games/the-oregon-trail/> one-for-one:

| Original | Mars Trail equivalent |
|---|---|
| Wagon | *Conestoga*-class transit ship |
| Oxen (×2–8) | **Drive cores** (×2–8) — degrade, overheat, fail, can be swapped at stations |
| Food (lbs) | Rations (kg) |
| Clothing | **Rad shielding + EVA suits** — protects during flare events and EVAs |
| Ammunition (boxes) | **Propellant cells** — spent on burns and on harvesting |
| Spare wheel / axle / tongue | Spare **coolant pump / heat-shield tile set / comms array / hull plate** |
| Matt's General Store | **Yard Requisition** at Canaveral; station commissaries at inflated markup |
| Money | Credits |
| Rivers to cross | **Hazard traversals** (see below) |
| Forts | **Stations**: LEO Transfer Ring, Lunar Gateway, L1 Waystation, Ceres Depot, Phobos Station |
| Landmarks | Kessler Belt, Van Allen Shear, Lunar Slingshot, Deep Quiet, Asteroid Fringe, Mars Orbital Insertion |
| Weather | **Space weather** — solar flares, CMEs, cosmic-ray flux, micrometeoroid density |
| Hunting minigame | **Volatile harvesting** — EVA and harpoon-drill passing ice fragments |
| Willamette Valley + Columbia rafting | **Mars aerobraking + powered descent** finale |
| Dysentery, cholera, typhoid | Radiation sickness, hypoxia, bone-density collapse, space adaptation syndrome, cabin psychosis, hydroponics blight (scurvy), decompression trauma |

### Professions (keep the original's inverted difficulty/score design)

| Profession | Starting credits | Score multiplier |
|---|---|---|
| Corporate Financier | 1,100 | ×1 |
| Ship's Engineer | 800 | ×2 — starts with repair proficiency |
| Terraform Homesteader | 400 | ×3 — starts with seed stock |

### Pace and rations

- **Burn rate:** `Coasting` / `Standard Burn` / `Hard Burn` — more km/day, faster drive-core
  wear and crew energy drain.
- **Rations:** `Filling` / `Meager` / `Bare Bones` — identical curve to the original.

### Hazard traversals (the "river crossings")

Each hazard offers four options with the original's risk shape:

1. **Burn through** — fast, free, real chance of hull breach / crew injury / cargo loss
2. **Creep through on thrusters** — slow, costs days and propellant, much safer
3. **Hire a tug escort / cleared corridor** — costs credits, near-safe
4. **Hold and wait for a window** — costs days only, safest, but eats the transfer deadline

Outcome probability is a function of hazard severity × current space weather × drive-core
condition — same as river depth × weather in the original.

## Structure

**5 legs**, matching the 2021 Switch version rather than the linear 1985 game. Each leg
opens on an illustrated star-chart with **branching route nodes** the player picks between
(shorter but hazardous vs. longer but station-serviced). Leg titles render in the terminal
style, e.g. `LEG 2 OF 5 — THE DEBRIS BELT_` with a blinking cursor.

Between waypoints: a **campsite/dock decision layer** — set up camp equivalents such as
*Hygiene Cycle* (restore hygiene, costs hours), *Hydroponics Tending*, *Drive Maintenance*,
*Crew Rest*. Each trades time for a stat.

**Win:** reach Ares Basin with ≥1 crew alive. **Lose:** all crew dead, or the transfer
window closes with the ship still in transit.

**Score:** `(surviving crew + remaining consumables + credits + ship condition) × profession multiplier`

## Visual Direction

Reproduce the **2021 Gameloft / Nintendo Switch** art language exactly — pixel-art
characters and vehicles composited into full 3D lit environments. Their real pipeline was:
model and animate in 3D → render each frame → hand-refine pixel by pixel. Reproduce that
look in-engine instead of by hand:

- Render the scene to a **low-resolution render target** (~480×270) and upscale with
  `NearestFilter`, so Mint-generated 3D models resolve as crisp sprites with true 3D
  volume and animation weight.
- **Palette-quantization post-process** derived from the 1985 Apple II palette, so every
  scene reads as one limited colour system.
- Then modern effects on top: bloom, dynamic lighting, god rays, depth fog, particles.

**Layer stack per scene** (match the screenshots):

1. Sky / space dome — drives the whole scene's colour temperature (dusk violet, deep navy, Mars ochre)
2. 3D parallax terrain and props — Earth limb, debris silhouettes, asteroid fields, station trusses, all scrolling at different rates as the ship travels
3. Pixel-resolved sprite cast — ship, drive cores, crew on EVA tethers, wildlife-equivalent (drifting satellites, ice fragments)
4. VFX pass — thruster plumes, ice crystals, snow-equivalent particulate, solar glare, fireflies-equivalent star drift
5. HUD

**Unlockable monochrome-green filter** — a full-screen phosphor post-process with
scanlines that recolours the entire 3D scene to single-hue CRT green, matching reference
screenshot 8. One post-pass toggle, not separate art.

## HUD Specification

Phosphor green `#4AE24A` primary, amber `#FFB627` secondary, dark translucent panels,
pixel typography throughout.

- **Top-left:** mission-date tile (`MAR / 21` calendar card, year 2091)
- **Top-left adjacent:** circular **space-weather dial** replacing the sun/weather dial — shows solar activity and flare risk
- **Top-centre:** `13 d` chip — days to next waypoint
- **Top-right row:** burn rate · rations · consumables mass · credits — four icon+label pairs
- **Left-middle:** green pixel chevrons + next waypoint name + distance (`Kessler Belt / 61,000 km`)
- **Bottom bar:** five crew cards — portrait, name, and stacked stat bars (health / energy / hygiene / morale / rad dose), with status tags rendered as inline chips (`RAD SICK`, `HYPOXIA`, skull icon on death)
- **Bottom-right:** dot-matrix grid readout for supply and crew status
- **Event cards:** full-width text panel over the live scene with 2–3 choice buttons (green primary, amber informational), styled like reference screenshot 7
- **Centre alert banner:** `☠ Your crew is starving` — green pixel banner over the scene

## Mint MCP Asset Plan

Resolve one Mint Project for this codebase first (`references/mint-project-workspaces.md`),
persist it in `mint-assets.json`, and sync through `scripts/sync-mint-assets.mjs`.

Generate as **discrete models composed in Three.js** — do not generate a Mint world unless
I explicitly ask:

- **Hero model:** *Conestoga*-class transit ship — boxy cargo hull, ribbed radiator panels, visible spine truss. Deliberately silhouette-echoes a covered wagon.
- **Animated model:** crew figure with walk, EVA-float, work, and collapse animation sets
- **Asset pack — debris field:** dead satellites, spent rocket bodies, torn solar arrays, tumbling panels, bolts
- **Asset pack — asteroids:** 5–6 rock variants at multiple scales
- **Asset pack — stations:** docking ring, habitat torus, depot cluster, Phobos anchor
- **Models:** drive core module, ice fragment, harpoon-drill EVA rig
- **Material pack:** scorched hull plate, heat-shield ablative, regolith, radiator ceramic
- **Images:** five crew portraits for the bottom bar, and the five leg star-chart maps
- **Audio:** engine hum loop, alarm klaxon, UI blip set, hull-stress groan

Use a **Draco-capable shared GLTF loader** — Mint-optimized GLBs are not compatible with a
bare `GLTFLoader` (`references/gltf-runtime-compatibility.md`).

## Technical Constraints

- TypeScript + Vite + vanilla Three.js modules (greenfield defaults)
- Target: desktop browser first, 60 fps; mobile-viable layout but do not run mobile QA without separate approval
- Keep all Mint MCP calls out of browser runtime code
- No provider branding, asset IDs, or generation links in the runtime UI

## Minimal State Model

```ts
crew:      { name, portrait, health, energy, hygiene, morale, radDose, illness, alive }[]
ship:      { driveCores, hullIntegrity, heatShield, coolantPumps, commsArray, spares }
inventory: { rationsKg, waterL, propellantCells, radSuits, credits }
progress:  { kmTraveled, missionDate, leg, nextWaypoint, kmToWaypoint, windowDaysLeft }
settings:  { burnRate, rations }
weather:   { solarActivity, flareRisk, debrisDensity }
```

Per turn: advance km → consume rations/water/propellant → tick crew stats → wear drive
cores → roll space-weather → roll events → resolve waypoint → check win/lose.

## Reference Material

**Gameplay rules to adapt:** <https://oregontrail.ws/games/the-oregon-trail/>

**Video reference (art direction, UI motion, game feel):**
<https://www.youtube.com/watch?v=Q623BxXOM0o>

**Attached screenshots** — the authoritative visual target. Eight frames from the Switch
version, in order:

1. Snowy Blue Mountains at dusk — parallax pines, wagon in midground, falling snow, full HUD visible with `Grueling / Filling / 53 lb / $120`
2. Bright prairie near Fort Kearny — daylight palette, `1 miles` to waypoint, four crew cards
3. Leg-select star-chart — `LEG 2 OF 5 – THE RUGGED PRAIRIES_` illustrated parchment map with branching route nodes and a green selection ring
4. Town street scene — 3D buildings, crowd sprites, `114 lb / $188`
5. Night snow at Fort Nez Perce — moon, heavy particulate, centre banner `☠ Your party is starving`, two crew flagged `FEVER`
6. Title card — logo treatment over a campfire scene
7. Event card — `CAMPSITE – WASH`, full-width text panel with three choice buttons
8. Monochrome green retro filter — entire scene in single-hue CRT phosphor

Match screenshot 1 and 5 for scene composition and HUD layout, screenshot 3 for the leg
map, screenshot 7 for event cards, screenshot 8 for the unlockable filter.

## Required Outcome

- Playable loop end-to-end: outfitting → 5 legs → hazard traversals → Mars descent → score screen
- Meaningful decisions with visible consequence, and a real fail/retry path
- Authored graphics and game UI at the quality bar the screenshots set
- Mint MCP for every production asset; files integrated locally through `mint-assets.json`
- Run the automatic non-browser verification minimum, then propose a scoped desktop
  browser pass and wait for approval before running it
- Report controls, changed files, verification evidence, the Mint handoff, and remaining risks

Start by proposing the leg/waypoint layout and the asset generation order for my review
before generating anything.
