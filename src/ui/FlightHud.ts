/**
 * Real-time readout shown while flying.
 *
 * Deliberately sparse: during a sequence the player's eyes are on the corridor,
 * so this carries only what changes a decision — how far through you are, how
 * hard you have been hit, and whether you have drifted off the lane.
 */

import type { FlightRunView } from '../flight/model/types';

export class FlightHud {
  private readonly root = this.element('#flight-hud');
  private readonly title = this.element('#flight-title');
  private readonly progress = this.element('#flight-progress');
  private readonly warning = this.element('#flight-warning');
  private readonly speed = this.element('#flight-speed');
  private readonly hits = this.element('#flight-hits');

  private lastHits = -1;

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setTitle(text: string): void {
    this.title.textContent = text;
    this.lastHits = -1;
  }

  update(view: FlightRunView): void {
    this.progress.style.width = `${Math.round(view.progress * 100)}%`;
    this.speed.textContent = String(Math.round(view.speed * 10));

    if (view.hits !== this.lastHits) {
      this.lastHits = view.hits;
      this.hits.textContent = String(view.hits);
      // Colour the impact count once it starts to matter.
      this.hits.style.color = view.hits >= 4 ? 'var(--red)' : view.hits > 0 ? 'var(--amber)' : '';
    }

    this.warning.hidden = !view.offCorridor;
  }

  private element(selector: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) throw new Error(`Missing flight HUD element: ${selector}`);
    return node;
  }
}
