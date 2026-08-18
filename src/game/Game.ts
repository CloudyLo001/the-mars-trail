/**
 * THE MARS TRAIL — game orchestrator.
 *
 * Owns the renderer, the pixel pipeline, the travel scene, the HUD, the modal
 * screens, and the simulation. The sim owns all game state; this class only
 * routes phase changes to the right surface and pushes state into the view.
 */

import * as THREE from 'three';
import { Loop } from '../core/Loop';
import { createRenderer, resizeRenderer } from '../core/Renderer';
import { GameAssets } from '../assets/GameAssets';
import { PixelPipeline } from '../render/PixelPipeline';
import { TravelScene } from '../scene/TravelScene';
import { AudioSystem } from '../systems/AudioSystem';
import { FlightController, type FlightRequest } from '../flight/FlightController';
import { sequenceConfig } from '../flight/model/sequences';
import type { FlightRunResult, FlightSequenceId } from '../flight/model/types';
import { InputController } from '../core/InputController';
import { FlightHud } from '../ui/FlightHud';
import { Hud } from '../ui/Hud';
import { Screens } from '../ui/Screens';
import { loadSettings, saveSettings, type DisplaySettings } from '../ui/settings';
import { MarsTrailSim, autoplay, effectiveSeverity, flightSequenceFor, formatDistance } from '../sim';
import type { AutoplayStyle, BurnRate, GameState, HazardOptionId, Phase, RationLevel } from '../sim';
import { createSeededRandom } from '../utils/random';

/** Burn-rate to visual/audio intensity, 0-1. */
const BURN_FACTOR: Record<BurnRate, number> = {
  coasting: 0.18,
  standard: 0.5,
  hard: 1,
};

/** Scene scroll rate per burn rate, in arbitrary parallax units. */
const TRAVEL_RATE: Record<BurnRate, number> = {
  coasting: 1.4,
  standard: 2.4,
  hard: 3.8,
};

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: TravelScene;
  private readonly pipeline: PixelPipeline;
  private readonly assets = new GameAssets();
  private readonly audio = new AudioSystem();
  private readonly sim = new MarsTrailSim();
  private readonly screens: Screens;
  private readonly hud: Hud;
  private readonly flightHud = new FlightHud();
  private readonly input: InputController;
  /** Non-null while a real-time sequence owns the screen. */
  private flight: FlightController | null = null;
  /** Set by the test hook so a sequence can be replayed deterministically. */
  private flightSeedOverride: number | null = null;
  private readonly loop: Loop;

  private readonly bootStatus = document.querySelector<HTMLElement>('#boot-status')!;
  private filterButton: HTMLButtonElement | null = null;

  private frame = 0;
  private elapsed = 0;
  private reducedMotion = false;
  private pausedForScreenshot = false;
  private storeWarning = '';
  private stationMessage = '';
  private lastRenderedPhase: Phase | null = null;
  private logOpen = false;
  private tutorialOpen = false;
  private settingsOpen = false;
  private settings: DisplaySettings = loadSettings();
  /** Set while an outcome card is showing, so the phase router leaves it alone. */
  private pendingOutcome: { title: string; text: string; bad: boolean; next: () => void } | null = null;
  private lastCoreCount = -1;
  /** Guards against a stale per-leg prop load repopulating a newer leg. */
  private legSyncToken = 0;
  private rng = createSeededRandom(20910314);

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    // ACES tone mapping and shadows come from createRenderer and now stand.
    // They used to be overridden to linear because the posterise pass owned the
    // frame's value distribution; with the retro treatment off by default, that
    // override only flattened the image.

    this.input = new InputController(canvas);
    this.scene = new TravelScene(this.rng, 'earth-orbit');
    this.pipeline = new PixelPipeline(this.renderer, this.scene.scene, this.scene.camera);

    this.screens = new Screens({
      onStart: () => {
        this.audio.play('ui-confirm');
        this.sim.beginProfessionSelect();
      },
      onOpenTutorial: () => {
        this.tutorialOpen = true;
        this.audio.play('ui-click');
        this.renderPhase(true);
      },
      onCloseTutorial: () => {
        this.tutorialOpen = false;
        this.audio.play('ui-click');
        this.renderPhase(true);
      },
      onChooseProfession: (id) => {
        this.audio.play('ui-confirm');
        this.sim.chooseProfession(id);
      },
      onConfirmNames: (names) => {
        this.audio.play('ui-confirm');
        this.sim.nameCrew(names);
      },
      onBuy: (itemId, atStation) => {
        const message = this.sim.buy(itemId, atStation);
        this.audio.play('ui-click');
        if (atStation) this.stationMessage = message;
        else this.storeWarning = message;
        this.renderPhase(true);
      },
      onRefund: (itemId, atStation) => {
        const message = this.sim.refund(itemId, atStation);
        this.audio.play('ui-click');
        if (atStation) this.stationMessage = message;
        else this.storeWarning = message;
        this.renderPhase(true);
      },
      onDepart: () => {
        const result = this.sim.depart();
        if (!result.ok) {
          this.storeWarning = result.reason ?? '';
          this.audio.play('hazard');
          this.renderPhase(true);
          return;
        }
        this.audio.play('ui-confirm');
        this.audio.startAmbience();
        // Start flying immediately. Blocking departure on the asset stream left
        // the player staring at the outfitting screen for as long as ten
        // seconds with no feedback; the pad simply builds itself a beat later.
        this.startLaunch();
        void this.assets.ensureFamilies(['desert', 'asteroid']).then(() => {
          if (this.flight?.sequence === 'launch') {
            this.flight.setPadProps(this.assets.desert);
            this.flight.setObstacleProps(this.assets.asteroids);
          }
        });
      },
      onChooseRoute: (routeId) => {
        this.audio.play('ui-confirm');
        this.sim.chooseRoute(routeId);
        this.syncSceneToLeg();
      },
      onEventChoice: (choiceId) => {
        const text = this.sim.chooseEventOption(choiceId);
        this.audio.play('ui-click');
        this.showOutcome('Resolved', text, false);
      },
      onHazardChoice: (optionId) => {
        if (optionId !== 'fly') {
          this.resolveHazard(optionId);
          return;
        }
        const waypoint = this.sim.nextWaypoint();
        const sequence = waypoint ? flightSequenceFor(waypoint.id) : null;
        if (!sequence) {
          // No sequence for this waypoint: fall back to the dice rather than
          // stranding the player on a card with a dead button.
          this.resolveHazard('fly');
          return;
        }
        this.beginFlight(sequence as FlightSequenceId, (result) =>
          this.resolveHazard('fly', result.performance),
        );
      },
      onStationService: (serviceId) => {
        const text = this.sim.stationService(serviceId);
        this.audio.play('ui-confirm');
        this.stationMessage = text;
        // A long service can burn the last of the transfer window.
        if (this.sim.get().outcome !== 'in-progress') this.pendingOutcome = null;
        this.renderPhase(true);
      },
      onLeaveStation: () => {
        this.stationMessage = '';
        this.audio.play('ui-click');
        this.sim.leaveWaypoint();
      },
      onCampOption: (optionId) => {
        const text = this.sim.campOption(optionId);
        this.audio.play('ui-confirm');
        this.showOutcome('Camp', text, false, () => this.sim.leaveWaypoint());
      },
      onHarvest: (accuracy) => {
        const result = this.sim.harvest(accuracy);
        this.audio.play('ui-confirm');
        this.showOutcome('Harvest', result.message, false, () => this.sim.leaveWaypoint());
      },
      onSkipHarvest: () => {
        this.audio.play('ui-click');
        this.sim.leaveWaypoint();
      },
      onAcknowledge: () => {
        const pending = this.pendingOutcome;
        this.pendingOutcome = null;
        this.audio.play('ui-click');
        if (pending?.next) pending.next();
        else this.renderPhase(true);
      },
      onRestart: () => {
        this.audio.play('ui-confirm');
        this.tutorialOpen = false;
        this.logOpen = false;
        this.settingsOpen = false;
        this.storeWarning = '';
        this.stationMessage = '';
        this.pendingOutcome = null;
        this.sim.reset();
        this.syncSceneToLeg();
      },
      onCloseLog: () => {
        this.logOpen = false;
        this.audio.play('ui-click');
        this.renderPhase(true);
      },
      onOpenSettings: () => {
        this.settingsOpen = true;
        this.audio.play('ui-click');
        this.renderPhase(true);
      },
      onCloseSettings: () => {
        this.settingsOpen = false;
        this.audio.play('ui-click');
        this.renderPhase(true);
      },
      onChangeSettings: (patch) => {
        this.settings = { ...this.settings, ...patch };
        saveSettings(this.settings);
        this.applySettings();
        this.audio.play('ui-click');
        this.renderPhase(true);
      },
    });

    this.hud = new Hud(this.assets, {
      onBurnRate: (rate: BurnRate) => {
        this.sim.setBurnRate(rate);
        this.audio.play('ui-click');
      },
      onRations: (level: RationLevel) => {
        this.sim.setRations(level);
        this.audio.play('ui-click');
      },
      onAdvance: () => {
        this.sim.step();
        this.announcePhaseAudio();
      },
      onCamp: () => {
        this.audio.play('ui-click');
        this.sim.makeCamp();
      },
      onLog: () => {
        this.logOpen = true;
        this.audio.play('ui-click');
        this.renderPhase(true);
      },
      onHelp: () => {
        this.tutorialOpen = true;
        this.audio.play('ui-click');
        this.renderPhase(true);
      },
    });

    this.buildSettingsButton();
    this.applySettings();

    this.sim.subscribe(() => this.renderPhase());
    this.loop = new Loop(
      (delta, elapsed) => this.update(delta, elapsed),
      () => this.render(),
    );

    resizeRenderer(this.renderer, this.scene.camera, 2);
    this.pipeline.resize(canvas.clientWidth, canvas.clientHeight);
    this.installTestHooks();
    this.publishDiagnostics();
  }

  async start(): Promise<void> {
    this.loop.start();

    // Paint the title immediately. Nothing on it depends on generated assets,
    // and gating it behind the whole asset set made startup feel broken.
    this.renderPhase(true);
    this.bootStatus.textContent = 'Loading…';

    const report = await this.assets.loadEssential();

    if (this.assets.error) {
      this.bootStatus.classList.add('is-error');
      this.bootStatus.textContent = `Asset load failed — ${this.assets.error}`;
    } else if (report.missing.length > 0) {
      this.bootStatus.textContent = `Ready (${report.missing.length} assets unavailable)`;
      window.setTimeout(() => (this.bootStatus.hidden = true), 4000);
    } else {
      this.bootStatus.hidden = true;
    }

    // One vehicle throughout: the ascender you launch in is the ship you fly
    // the whole crossing in, rather than swapping to a different hull offscreen.
    const hull = this.assets.rocket ?? this.assets.hull;
    if (hull) this.scene.ship.setHullModel(hull);
    if (this.assets.core) this.scene.ship.setCoreModel(this.assets.core);
    this.audio.registerUrls(this.assets.audioUrls);
    // Portraits resolved after the HUD's first paint, so the cached crew cards
    // have to be rebuilt or they keep their empty <img> sources forever.
    this.hud.invalidateCrewCards();
    this.syncSceneToLeg();
    this.renderPhase(true);
  }

  dispose(): void {
    this.loop.stop();
    this.input.detach();
    this.flight?.dispose();
    this.audio.dispose();
    this.pipeline.dispose();
    this.scene.dispose();
    this.assets.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  // ------------------------------------------------------------ presentation

  private buildSettingsButton(): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-toggle';
    button.id = 'btn-settings';
    button.title = 'Display settings';
    button.setAttribute('aria-label', 'Display settings');
    button.textContent = '⚙ Settings';
    button.addEventListener('click', () => {
      this.settingsOpen = true;
      this.audio.play('ui-click');
      this.renderPhase(true);
    });
    document.querySelector('#app')?.appendChild(button);
    this.filterButton = button;
  }

  /**
   * Fly the ascent out of Earth's atmosphere.
   *
   * Retryable and consequence-free by design: a botched climb resets to the
   * pad rather than ending a run the player has just spent ten minutes
   * outfitting. That also makes it the tutorial for the controls.
   */
  private startLaunch(): void {
    this.beginFlight('launch', (result) => {
      // The ascent cannot fail. It is the first thing a new run touches, it is
      // the tutorial for the controls, and being bounced back to the pad after
      // ten minutes of outfitting is the most discouraging thing this game
      // could do. Performance only decides the flavour of the arrival.
      const clean = result.performance > 0.7;
      this.showOutcome(
        'ORBIT ACHIEVED',
        clean
          ? 'A clean ascent. The tower falls away, the sky goes black, and Mars is two hundred and twenty-five million kilometres ahead.'
          : 'Rough, and the hull has the scars to prove it — but you are up. The sky goes black and the real crossing begins.',
        false,
      );
    });
  }

  /**
   * Hand the screen to a real-time sequence.
   *
   * The pipeline already supports swapping its scene and camera, so this costs
   * nothing structurally — the turn-based scene stays intact and is restored
   * untouched when the sequence resolves.
   */
  private beginFlight(sequence: FlightSequenceId, onComplete: (r: FlightRunResult) => void): void {
    if (this.flight) return;
    const config = sequenceConfig(sequence);

    const props =
      config.family === 'debris'
        ? this.assets.debris
        : config.family === 'asteroid'
          ? this.assets.asteroids
          : [];

    const request: FlightRequest = {
      sequence,
      seed:
        this.flightSeedOverride ??
        this.sim.get().day * 7919 + this.sim.get().legIndex * 131 + 17,
      props,
      onComplete: (result) => this.endFlight(result, onComplete),
    };

    this.flight = new FlightController(
      request,
      this.input,
      this.rng,
      () => this.reducedMotion,
      // The ascent flies the launch vehicle over the desert complex; every
      // other sequence flies the transit hull through open space.
      sequence === 'launch' ? this.assets.desert : [],
    );
    const vehicle = this.assets.rocket ?? this.assets.hull;
    if (vehicle) this.flight.setShipModel(vehicle.clone(true));

    this.pipeline.setSceneAndCamera(this.flight.scene.scene, this.flight.scene.chase.camera);
    this.flight.resize(this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    this.input.attach();

    this.screens.hide();
    this.hud.setVisible(false);
    this.flightHud.setTitle(config.title);
    this.flightHud.setVisible(true);
    this.audio.play('hazard');
  }

  private endFlight(result: FlightRunResult, onComplete: (r: FlightRunResult) => void): void {
    this.input.detach();
    this.flightHud.setVisible(false);

    // Restore the turn-based scene before anything re-renders.
    this.pipeline.setSceneAndCamera(this.scene.scene, this.scene.camera);
    this.flight?.dispose();
    this.flight = null;

    onComplete(result);
    // renderPhase caches the last phase, and it went stale while the overlay
    // pre-empted routing, so this must force.
    this.renderPhase(true);
  }

  /** Push display settings into the render pipeline. Presentation only. */
  private applySettings(): void {
    this.pipeline.setInternalHeight(this.settings.internalHeight);
    this.pipeline.resize(this.canvas.clientWidth, this.canvas.clientHeight);
    this.pipeline.setExposure(this.settings.exposure);
    this.pipeline.setPhosphor(this.settings.phosphor);
    this.pipeline.setRetro(this.settings.retro);
    // The retro treatment owns the value range when it is on, so linear
    // tone mapping is correct there and ACES is correct otherwise.
    this.renderer.toneMapping = this.settings.retro
      ? THREE.NoToneMapping
      : THREE.ACESFilmicToneMapping;
  }

  /**
   * Switch the scene to the current leg, streaming in only the prop families
   * that leg draws from. The palette change applies immediately; props appear
   * when their family finishes loading.
   */
  private syncSceneToLeg(): void {
    const leg = this.sim.leg();
    this.scene.setSceneKey(leg.sceneKey);

    const populate = () =>
      this.scene.populateProps({
        debris: this.assets.debris,
        asteroids: this.assets.asteroids,
        stations: this.assets.stations,
        sceneKey: leg.sceneKey,
      });

    // Draw whatever is already cached, then again once the rest arrives.
    populate();

    const families = this.assets.familiesForScene(leg.sceneKey);
    const token = ++this.legSyncToken;
    void this.assets.ensureFamilies(families).then(() => {
      // A fast leg change can land while this is in flight; only the newest
      // request is allowed to repopulate.
      if (token === this.legSyncToken) populate();
    });
  }

  private showOutcome(title: string, text: string, bad: boolean, next?: () => void): void {
    // If the action that produced this outcome also ended the run, the score
    // screen is the honest next surface — an outcome card here would be
    // immediately overwritten and the player would never see either.
    if (this.sim.get().outcome !== 'in-progress') {
      this.pendingOutcome = null;
      this.renderPhase(true);
      return;
    }

    this.pendingOutcome = {
      title,
      text,
      bad,
      next: next ?? (() => this.renderPhase(true)),
    };
    this.screens.renderOutcome(title, text, { bad });
  }

  private resolveHazard(optionId: HazardOptionId, performance?: number): void {
    const resolution = this.sim.resolveHazard(optionId, performance);
    if (!resolution) return;

    this.audio.play(resolution.grade === 'disaster' ? 'death' : 'hazard');

    const state = this.sim.get();
    // A hazard that ended the run must fall through to the score screen.
    if (state.outcome !== 'in-progress') {
      this.pendingOutcome = null;
      this.renderPhase(true);
      return;
    }

    this.showOutcome(resolution.headline, resolution.detail, resolution.grade !== 'clean', () =>
      this.sim.leaveWaypoint(),
    );
  }

  private announcePhaseAudio(): void {
    const phase = this.sim.get().phase;
    if (phase === 'hazard') this.audio.play('hazard');
    else if (phase === 'event') this.audio.play('ui-click');
    else if (phase === 'arrived') this.audio.play('arrive');
    else if (phase === 'lost') this.audio.play('death');
  }

  /**
   * Route the current phase to the right surface.
   * @param force redraw even when the phase has not changed, after a purchase
   *   or service that mutated the panel's own content.
   */
  private renderPhase(force = false): void {
    const state = this.sim.get();

    // An outcome card owns the screen until acknowledged.
    if (this.pendingOutcome && state.outcome === 'in-progress') {
      this.updateHud(state);
      return;
    }

    // A live sequence owns the screen ahead of every modal overlay.
    if (this.flight) {
      this.screens.hide();
      this.hud.setVisible(false);
      this.flightHud.setVisible(true);
      return;
    }

    if (this.settingsOpen) {
      this.screens.renderSettings(this.settings);
      this.updateHud(state);
      return;
    }

    if (this.tutorialOpen) {
      this.screens.renderTutorial();
      this.updateHud(state);
      return;
    }

    if (this.logOpen) {
      this.screens.renderLog(state);
      this.updateHud(state);
      return;
    }

    const changed = state.phase !== this.lastRenderedPhase;
    if (!changed && !force) {
      this.updateHud(state);
      return;
    }
    this.lastRenderedPhase = state.phase;

    const travelling = state.phase === 'travel';
    this.hud.setVisible(
      state.phase !== 'title' &&
        state.phase !== 'profession' &&
        state.phase !== 'crew-naming' &&
        state.phase !== 'outfitting',
    );
    this.hud.setControlsEnabled(travelling);


    switch (state.phase) {
      case 'title':
        this.screens.renderTitle();
        break;
      case 'profession':
        this.screens.renderProfessionSelect();
        break;
      case 'crew-naming':
        this.screens.renderCrewNaming(state);
        break;
      case 'outfitting':
        this.screens.renderOutfitting(this.sim, this.storeWarning);
        break;
      case 'leg-select':
        this.screens.renderLegSelect(state);
        break;
      case 'travel':
        this.screens.hide();
        break;
      case 'event':
        if (state.activeEvent) this.screens.renderEvent(state.activeEvent);
        break;
      case 'hazard': {
        const waypoint = this.sim.nextWaypoint();
        if (waypoint) {
          this.screens.renderHazard(
            waypoint,
            this.sim.hazardOptions(),
            effectiveSeverity(state, waypoint),
            state,
          );
        }
        break;
      }
      case 'station': {
        const waypoint = this.sim.nextWaypoint();
        if (waypoint) this.screens.renderStation(this.sim, waypoint, this.stationMessage);
        break;
      }
      case 'harvest': {
        const waypoint = this.sim.nextWaypoint();
        if (waypoint) this.screens.renderHarvest(state, waypoint);
        break;
      }
      case 'camp': {
        const waypoint = state.voluntaryCamp ? null : this.sim.nextWaypoint();
        this.screens.renderCamp(state, waypoint);
        break;
      }
      case 'arrived':
      case 'lost':
        this.screens.renderScore(state, this.sim.score());
        break;
      default:
        this.screens.hide();
        break;
    }

    this.updateHud(state);
  }

  private updateHud(state: GameState): void {
    const waypoint = this.sim.nextWaypoint();
    this.hud.update(state, {
      daysToNext: this.sim.daysToNext(),
      nextName: waypoint?.name ?? this.sim.leg().to,
      kmToNext: this.sim.kmToNext(),
    });
  }

  // ---------------------------------------------------------------- runtime

  private update(delta: number, elapsed: number): void {
    this.frame += 1;
    if (this.pausedForScreenshot) {
      this.publishDiagnostics();
      return;
    }
    this.elapsed = elapsed;

    if (resizeRenderer(this.renderer, this.scene.camera, 2)) {
      this.pipeline.resize(this.canvas.clientWidth, this.canvas.clientHeight);
      this.scene.resize(this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    }

    if (this.flight) {
      this.flight.update(delta, elapsed);
      if (this.flight) this.flightHud.update(this.flight.view);
      this.publishDiagnostics();
      return;
    }

    const state = this.sim.get();
    const moving = state.phase === 'travel' && state.outcome === 'in-progress';
    const burnFactor = BURN_FACTOR[state.burnRate];

    this.scene.update(delta, elapsed, {
      sceneKey: this.sim.leg().sceneKey,
      // Docked and modal phases still drift a little; a dead-frozen scene
      // behind a dialog reads as a broken game rather than a paused one.
      travelRate: moving ? TRAVEL_RATE[state.burnRate] : 0.35,
      burnFactor: moving ? burnFactor : 0.12,
      coreCount: state.ship.driveCores,
      reducedMotion: this.reducedMotion,
    });

    if (state.ship.driveCores !== this.lastCoreCount) {
      this.lastCoreCount = state.ship.driveCores;
      this.audio.setBurnIntensity(moving ? burnFactor : 0.1);
    }

    this.publishDiagnostics();
  }

  private render(): void {
    this.pipeline.render();
  }

  private installTestHooks(): void {
    // Deterministic hooks consumed by tests/visual.spec.ts. These drive real
    // state transitions; silent no-ops would produce flaky baselines.
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.rng = createSeededRandom(value);
        this.sim.reseed(value);
      },
      setState: (name: string) => {
        switch (name) {
          case 'active-play':
            this.sim.reset();
            this.sim.primeForTravel(0);
            this.syncSceneToLeg();
            break;
          case 'deep-space':
            this.sim.reset();
            this.sim.primeForTravel(2);
            this.syncSceneToLeg();
            break;
          case 'mars-approach':
            this.sim.reset();
            this.sim.primeForTravel(4);
            this.syncSceneToLeg();
            break;
          case 'event':
            this.sim.reset();
            this.sim.primeForTravel(1);
            this.syncSceneToLeg();
            this.sim.forceEvent();
            break;
          case 'complete':
            this.sim.reset();
            this.sim.primeForTravel(4);
            this.syncSceneToLeg();
            this.sim.get().outcome = 'arrived';
            this.sim.get().phase = 'arrived';
            this.renderPhase(true);
            break;
          case 'title':
            this.sim.reset();
            break;
          default:
            console.warn(`Unknown test state: ${name}`);
        }
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
      },
      hideDebugUi: (hidden: boolean) => {
        if (this.filterButton) this.filterButton.hidden = hidden;
        this.bootStatus.hidden = hidden;
      },
      setInternalHeight: (height: number) => {
        this.settings = { ...this.settings, internalHeight: height };
        this.applySettings();
      },
      /**
       * Bot playtest: play a whole run under a named policy and land on the
       * real score screen. Every step goes through the normal commands, so the
       * ending is one a player could actually reach.
       */
      startFlight: (sequence: string, seed: number) => {
        this.flightSeedOverride = seed;
        this.beginFlight(sequence as FlightSequenceId, () => this.renderPhase(true));
        this.flightSeedOverride = null;
      },
      setFlightAutopilot: (skill: number | null) => {
        this.flight?.setAutopilot(skill);
      },
      flightSnapshot: () => {
        if (!this.flight) return { active: false };
        const view = this.flight.view;
        return {
          active: true,
          sequence: this.flight.sequence,
          seconds: view.seconds,
          progress: view.progress,
          hits: view.hits,
          shipX: view.shipX,
          shipY: view.shipY,
          cinematic: view.cinematic,
          liftoff: view.liftoff,
        };
      },
      abortFlight: () => {
        this.flight?.abort();
      },
      fastForwardFlight: (seconds: number) => {
        this.flight?.fastForward(seconds);
      },
      playToEnd: (style: string, seed: number) => {
        this.tutorialOpen = false;
        this.logOpen = false;
        this.settingsOpen = false;
        this.pendingOutcome = null;
        const result = autoplay(this.sim, style as AutoplayStyle, seed);
        this.syncSceneToLeg();
        this.renderPhase(true);
        return result;
      },
      setPhosphor: (enabled: boolean) => {
        this.settings = { ...this.settings, phosphor: enabled };
        this.pipeline.setPhosphor(enabled);
      },
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const state = this.sim.get();
    const buffer = this.pipeline.bufferSize;

    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      score: state.score,
      targetScore: 0,
      complete: state.outcome !== 'in-progress',
      phase: state.phase,
      outcome: state.outcome,
      mission: {
        day: state.day,
        windowDaysLeft: state.windowDaysLeft,
        leg: state.legIndex + 1,
        routeId: state.routeId,
        kmTotal: state.kmTotal,
        kmTotalLabel: formatDistance(state.kmTotal),
        driveCores: state.ship.driveCores,
        hullIntegrity: state.ship.hullIntegrity,
        livingCrew: state.crew.filter((member) => member.alive).length,
        rationsKg: Math.round(state.inventory.rationsKg),
      },
      flight: this.flight
        ? {
            active: true,
            sequence: this.flight.sequence,
            progress: this.flight.view.progress,
            hits: this.flight.view.hits,
          }
        : { active: false },
      pipeline: {
        internalWidth: buffer.width,
        internalHeight: buffer.height,
        phosphor: this.pipeline.phosphorEnabled,
        exposure: this.pipeline.exposure,
        scrollX: this.scene.scrollX,
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      },
    };
  }
}
