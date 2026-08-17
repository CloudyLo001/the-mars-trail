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
import { Hud } from '../ui/Hud';
import { Screens } from '../ui/Screens';
import { loadSettings, saveSettings, type DisplaySettings } from '../ui/settings';
import { MarsTrailSim, autoplay, effectiveSeverity, formatDistance } from '../sim';
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
    // Tone mapping is deliberately linear: the posterise pass owns the final
    // value distribution, and ACES would soften the bands it depends on.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = false;

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
      onHazardChoice: (optionId) => this.resolveHazard(optionId),
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

    if (this.assets.hull) this.scene.ship.setHullModel(this.assets.hull);
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

  /** Push display settings into the render pipeline. Presentation only. */
  private applySettings(): void {
    this.pipeline.setInternalHeight(this.settings.internalHeight);
    this.pipeline.resize(this.canvas.clientWidth, this.canvas.clientHeight);
    this.pipeline.setExposure(this.settings.exposure);
    this.pipeline.setPhosphor(this.settings.phosphor);
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

  private resolveHazard(optionId: HazardOptionId): void {
    const resolution = this.sim.resolveHazard(optionId);
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
