/**
 * @file core/driver-adapters.ts
 * @description Adapt an {@link IComputerDriver} to the executor's InputSink and
 * structured-actor hooks, so the executor is fully platform-agnostic: swap the
 * driver and the same executor drives X11, Wayland, Windows, or macOS.
 */

import type { IComputerDriver } from './driver.js';
import type { InputSink } from './executor.js';
import type { Grounded } from './types.js';

/** An InputSink that routes every action through driver.inject on `target`. */
export function driverSink(driver: IComputerDriver, target: string): InputSink {
  return {
    click: (x, y) => driver.inject(target, { kind: 'click', x, y }),
    doubleClick: (x, y) => driver.inject(target, { kind: 'double_click', x, y }),
    move: (x, y) => driver.inject(target, { kind: 'move', x, y }),
    type: (text) => driver.inject(target, { kind: 'type', text }),
    key: (key) => driver.inject(target, { kind: 'key', key }),
    scroll: (direction) => driver.inject(target, { kind: 'scroll', direction }),
    focusWindow: (title) => driver.inject(target, { kind: 'focus_window', window: title }),
  };
}

/** A structured-action hook that invokes a grounded element's accessibility action. */
export function driverStructuredActor(driver: IComputerDriver, target: string): (g: Grounded) => Promise<boolean> {
  return async (g: Grounded) => {
    if (!g.element?.name || !driver.capabilities().structuredAction) return false;
    return driver.structuredAction(target, { name: g.element.name, role: g.element.role, app: g.element.app });
  };
}
