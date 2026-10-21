import { type Clock, DEFAULT_NOW, frozenClock } from "./clock.js";
import { Store } from "./db.js";
import { Fixtures } from "./fixtures.js";
import { seed } from "./seed.js";

// A fresh store for a test, scenario or demo. The base seed is built once per process and copied,
// so each world starts from the same data in well under a millisecond.

export interface World {
  store: Store;
  clock: Clock;
  f: Fixtures;
}

const snapshots = new Map<string, Uint8Array>();

/** `base: false` gives an empty store, for tests that want to build every record themselves. */
export function world(opts: { base?: boolean; now?: string } = {}): World {
  const now = opts.now ?? DEFAULT_NOW;
  const clock = frozenClock(now);
  let store: Store;
  if (opts.base === false) store = new Store();
  else {
    let snap = snapshots.get(now);
    if (!snap) {
      const s = new Store();
      seed(s, clock);
      snap = s.snapshot();
      snapshots.set(now, snap);
      s.close();
    }
    store = Store.fromSnapshot(snap);
  }
  return { store, clock, f: new Fixtures(store, clock) };
}
