import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BossHud,
  BOSS_HP_COLORS,
  BOSS_HUD_DAMAGE_DURATION_MS,
  BOSS_HUD_DEFAULT_TITLE,
  BOSS_HUD_GHOST_HOLD_MS,
  BOSS_HUD_MAX_DAMAGE,
  BOSS_HUD_SEGMENTS,
  formatHpReadout,
  formatHpWidth,
  hpColor,
  hpWidthPct,
} from './bossHud.ts';

// Minimal zero-dependency DOM harness so BossHud's real DOM behavior can be
// verified directly under `node --test` without adding jsdom to package.json.
class MockClassList {
  private set = new Set<string>();

  syncFromString(str: string): void {
    this.set.clear();
    for (const tok of str.split(/\s+/)) {
      if (tok) this.set.add(tok);
    }
  }

  toString(): string {
    return [...this.set].join(' ');
  }

  contains(cls: string): boolean {
    return this.set.has(cls);
  }

  toggle(cls: string, force?: boolean): boolean {
    const next = force !== undefined ? force : !this.set.has(cls);
    if (next) this.set.add(cls);
    else this.set.delete(cls);
    return next;
  }
}

class MockStyle {
  private props: Record<string, string> = {};

  get cssText(): string {
    return Object.entries(this.props)
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
  }

  set cssText(val: string) {
    this.props = {};
    for (const part of val.split(';')) {
      const idx = part.indexOf(':');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) {
        const camel = k.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
        this.props[camel] = v;
      }
    }
  }

  getProp(k: string): string {
    return this.props[k] ?? '';
  }

  setProp(k: string, v: string): void {
    this.props[k] = v;
  }
}

function makeStyleProxy(): Record<string, string> {
  const target = new MockStyle();
  return new Proxy(target as unknown as Record<string, string>, {
    get(t, prop: string) {
      if (prop === 'cssText') return (t as unknown as MockStyle).cssText;
      return (t as unknown as MockStyle).getProp(prop);
    },
    set(t, prop: string, val: string) {
      if (prop === 'cssText') {
        (t as unknown as MockStyle).cssText = String(val);
      } else {
        (t as unknown as MockStyle).setProp(prop, String(val));
      }
      return true;
    },
  });
}

class MockElement {
  readonly tagName: string;
  readonly ownerDocument: MockDocument;
  readonly children: MockElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = new MockClassList();
  readonly style = makeStyleProxy();
  parentNode: MockElement | null = null;
  id = '';
  offsetWidth = 100;
  private _text = '';

  constructor(tagName: string, ownerDocument: MockDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get className(): string {
    return this.classList.toString();
  }

  set className(val: string) {
    this.classList.syncFromString(val);
  }

  get textContent(): string {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(val: string) {
    this.children.length = 0;
    this._text = String(val);
  }

  appendChild(child: MockElement): MockElement {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: MockElement[]): void {
    for (const n of nodes) this.appendChild(n);
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx !== -1) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const out: MockElement[] = [];
    const dataRoleMatch = /^\[data-role="([^"]+)"\]$/.exec(selector);
    const dataHudMatch = /^\[data-hud="([^"]+)"\]$/.exec(selector);
    const classMatch = /^\.([a-zA-Z0-9_-]+)$/.exec(selector);

    const visit = (node: MockElement) => {
      for (const c of node.children) {
        const matched =
          (dataRoleMatch && c.dataset.role === dataRoleMatch[1]) ||
          (dataHudMatch && c.dataset.hud === dataHudMatch[1]) ||
          (classMatch && c.classList.contains(classMatch[1]));
        if (matched) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class MockDocument {
  readonly documentElement: MockElement;
  readonly head: MockElement;
  readonly body: MockElement;

  constructor() {
    this.documentElement = new MockElement('html', this);
    this.head = new MockElement('head', this);
    this.body = new MockElement('body', this);
    this.documentElement.append(this.head, this.body);
  }

  createElement(tag: string): MockElement {
    return new MockElement(tag, this);
  }

  getElementById(id: string): MockElement | null {
    const visit = (node: MockElement): MockElement | null => {
      if (node.id === id) return node;
      for (const c of node.children) {
        const found = visit(c);
        if (found) return found;
      }
      return null;
    };
    return visit(this.documentElement);
  }
}

function createMockParent(): { doc: MockDocument; parent: HTMLElement; rawParent: MockElement } {
  const doc = new MockDocument();
  return {
    doc,
    parent: doc.body as unknown as HTMLElement,
    rawParent: doc.body,
  };
}

// --- Pure helper tests ---

test('hpWidthPct computes exact clamped percentages', () => {
  assert.equal(hpWidthPct(64000, 128000), 50);
  assert.equal(formatHpWidth(hpWidthPct(64000, 128000)), '50%');
  assert.equal(hpWidthPct(128000, 128000), 100);
  assert.equal(hpWidthPct(0, 128000), 0);
  assert.equal(hpWidthPct(-100, 128000), 0);
  assert.equal(hpWidthPct(200000, 128000), 100);
  assert.equal(hpWidthPct(50, 0), 0);
  assert.equal(hpWidthPct(Number.NaN, 100), 0);
});

test('hpColor switches across >60% cyan, 30-60% yellow, <30% red, and phase 2 dark red', () => {
  assert.equal(hpColor(100), BOSS_HP_COLORS.high);
  assert.equal(hpColor(60.01), BOSS_HP_COLORS.high);
  assert.equal(hpColor(60), BOSS_HP_COLORS.mid);
  assert.equal(hpColor(45), BOSS_HP_COLORS.mid);
  assert.equal(hpColor(30), BOSS_HP_COLORS.mid);
  assert.equal(hpColor(29.99), BOSS_HP_COLORS.low);
  assert.equal(hpColor(0), BOSS_HP_COLORS.low);
  assert.equal(hpColor(95, 2), BOSS_HP_COLORS.phase2);
  assert.equal(hpColor(15, 2), BOSS_HP_COLORS.phase2);
});

test('formatHpReadout formats Boss HP numbers cleanly', () => {
  assert.equal(formatHpReadout(128000, 128000).fullText, '128000 / 128000');
  assert.equal(formatHpReadout(64000, 128000).fullText, '64000 / 128000');
  assert.equal(formatHpReadout(0.2, 128000).fullText, '1 / 128000');
  assert.equal(formatHpReadout(-5, 128000).fullText, '0 / 128000');
});

// --- DOM structure & behavior tests ---

test('BossHud renders default title, pointer-events:none, and exactly 10 segment ticks', () => {
  const { doc, parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);

  const root = rawParent.querySelector('[data-hud="boss-hud"]');
  assert.ok(root, 'BossHud root should be mounted into parent');
  assert.equal(root.style.pointerEvents, 'none');

  const title = root.querySelector('[data-role="boss-title"]');
  assert.equal(title?.textContent, BOSS_HUD_DEFAULT_TITLE);

  const ticks = root.querySelectorAll('[data-role="hp-tick"]');
  assert.equal(ticks.length, BOSS_HUD_SEGMENTS);
  assert.equal(ticks.length, 10);

  const styleEl = doc.getElementById('boss-hud-styles');
  assert.ok(styleEl, 'BossHud stylesheet should be injected into document.head');

  hud.dispose();
});

test('setHp updates fill width percentage, readout text, and threshold colors', () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent, { title: 'APEX · PROTOTYPE' });

  const title = rawParent.querySelector('[data-role="boss-title"]');
  const fill = rawParent.querySelector('[data-role="boss-hp-fill"]');
  const readout = rawParent.querySelector('[data-role="boss-hp-text"]');
  assert.equal(title?.textContent, 'APEX · PROTOTYPE');
  assert.ok(fill && readout);

  // >60%: cyan
  hud.setHp(102400, 128000);
  assert.equal(fill.style.width, '80%');
  assert.equal(fill.style.backgroundColor, '#38E0E8');
  assert.equal(readout.textContent, '102400 / 128000');

  // 50% (30-60%): yellow
  hud.setHp(64000, 128000);
  assert.equal(fill.style.width, '50%');
  assert.equal(fill.style.backgroundColor, '#FFB454');
  assert.equal(readout.textContent, '64000 / 128000');

  // <30%: red
  hud.setHp(25600, 128000);
  assert.equal(fill.style.width, '20%');
  assert.equal(fill.style.backgroundColor, '#FF4D4D');
  assert.equal(readout.textContent, '25600 / 128000');

  hud.dispose();
});

test('setHp trails white ghost bar on damage and snaps immediately on heal', async () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const ghost = rawParent.querySelector('[data-role="boss-hp-ghost"]')!;

  hud.setHp(128000, 128000);
  assert.equal(ghost.style.width, '100%');

  hud.setHp(64000, 128000);
  // Immediately after hit, ghost holds previous width so the white trail shows
  assert.equal(ghost.style.width, '100%');

  await new Promise((r) => setTimeout(r, BOSS_HUD_GHOST_HOLD_MS + 35));
  assert.equal(ghost.style.width, '50%');
  assert.ok(ghost.style.transition.includes('350ms'), 'ghost bar should animate catch-up over 350ms');

  // Repeated identical setHp calls (e.g. 60fps loop) must NOT cancel the active 350ms transition
  hud.setHp(64000, 128000);
  assert.ok(ghost.style.transition.includes('350ms'), 'unchanged setHp should preserve ghost transition');

  // Healing snaps ghost immediately
  hud.setHp(128000, 128000);
  assert.equal(ghost.style.width, '100%');
  assert.equal(ghost.style.transition, 'none');

  hud.dispose();
});

test('setPhase(2) applies dark red fill and 1.6s outer glow pulse class, setPhase(1) reverts', () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const fill = rawParent.querySelector('[data-role="boss-hp-fill"]')!;
  const track = rawParent.querySelector('[data-role="boss-bar-track"]')!;

  hud.setHp(100000, 128000);
  assert.equal(fill.style.backgroundColor, '#38E0E8');
  assert.equal(track.classList.contains('boss-hud-phase2-pulse'), false);

  hud.setPhase(2);
  assert.equal(fill.style.backgroundColor, BOSS_HP_COLORS.phase2);
  assert.equal(track.classList.contains('boss-hud-phase2-pulse'), true);

  hud.setPhase(1);
  assert.equal(fill.style.backgroundColor, '#38E0E8');
  assert.equal(track.classList.contains('boss-hud-phase2-pulse'), false);

  hud.dispose();
});

test('setVisible toggles root display state cleanly', () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const root = rawParent.querySelector('[data-hud="boss-hud"]')!;

  hud.setVisible(false);
  assert.equal(root.style.display, 'none');
  assert.equal(root.dataset.visible, '0');

  hud.setVisible(true);
  assert.equal(root.style.display, '');
  assert.equal(root.dataset.visible, '1');

  hud.dispose();
});

test('showDamage caps DOM nodes at 12 when called 15 times, reusing oldest, and styles body vs weak', () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const dmgLayer = rawParent.querySelector('[data-role="boss-dmg-layer"]')!;

  // Off-screen projection should not spawn a node
  hud.showDamage(() => ({ x: 100, y: 100, visible: false }), 999, 'weak');
  assert.equal(dmgLayer.children.length, 0);

  for (let i = 1; i <= 15; i++) {
    const kind = i % 3 === 0 ? 'weak' : 'body';
    hud.showDamage(() => ({ x: 200 + i * 2, y: 180, visible: true }), i * 100, kind);
  }

  assert.equal(dmgLayer.children.length, BOSS_HUD_MAX_DAMAGE);
  assert.equal(dmgLayer.children.length, 12);

  // Oldest 3 (100, 200, 300) were reused by calls 13, 14, 15 (1300, 1400, 1500)
  const texts = dmgLayer.children.map((el) => el.textContent);
  assert.equal(texts.includes('100'), false);
  assert.equal(texts.includes('200'), false);
  assert.equal(texts.includes('300'), false);
  assert.equal(texts.includes('1300'), true);
  assert.equal(texts.includes('1400'), true);
  assert.equal(texts.includes('1500'), true);

  const bodyEl = dmgLayer.children.find((el) => el.dataset.kind === 'body')!;
  const weakEl = dmgLayer.children.find((el) => el.dataset.kind === 'weak')!;
  assert.equal(bodyEl.style.color, '#FFFFFF');
  assert.equal(bodyEl.style.fontSize, '12px');
  assert.equal(weakEl.style.color, '#FFC857');
  assert.equal(weakEl.style.fontSize, '16.8px');

  hud.dispose();
});

test('showDamage auto-removes floating node after 0.8s', async () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const dmgLayer = rawParent.querySelector('[data-role="boss-dmg-layer"]')!;

  hud.showDamage(() => ({ x: 180, y: 200, visible: true }), 450, 'body');
  assert.equal(dmgLayer.children.length, 1);

  await new Promise((r) => setTimeout(r, BOSS_HUD_DAMAGE_DURATION_MS + 60));
  assert.equal(dmgLayer.children.length, 0);

  hud.dispose();
});

test('dispose removes BossHud container from DOM cleanly and is idempotent', () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);

  assert.equal(rawParent.children.length, 1);
  hud.showDamage(() => ({ x: 150, y: 150, visible: true }), 320, 'weak');

  hud.dispose();
  assert.equal(rawParent.children.length, 0);

  // Calling dispose again or calling methods after dispose must not throw or re-add nodes
  hud.dispose();
  hud.setHp(50000, 128000);
  hud.showDamage(() => ({ x: 150, y: 150, visible: true }), 500, 'body');
  assert.equal(rawParent.children.length, 0);
});
