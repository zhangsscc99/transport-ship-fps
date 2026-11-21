// src/game/objective.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/match.ts
function createMatch(opts = {}) {
  const killsToWin = opts.teamKillsToWin ?? 25;
  const duration = opts.durationMs ?? 5 * 6e4;
  const countdownLen = opts.countdownMs ?? 3e3;
  let phase = "menu";
  let killsA = 0;
  let killsB = 0;
  let winner = null;
  let countdownStart = 0;
  let playStart = 0;
  let lastNow = 0;
  let timeLeft = duration;
  const judge = () => killsA > killsB ? "A" : killsB > killsA ? "B" : "draw";
  const finish = () => {
    phase = "over";
    winner = judge();
  };
  return {
    get phase() {
      return phase;
    },
    get killsToWin() {
      return killsToWin;
    },
    get killsA() {
      return killsA;
    },
    get killsB() {
      return killsB;
    },
    get winner() {
      return winner;
    },
    get timeLeftMs() {
      return timeLeft;
    },
    get countdownLeftMs() {
      return phase === "countdown" ? Math.max(0, countdownLen - (lastNow - countdownStart)) : 0;
    },
    start(now) {
      if (phase !== "menu" && phase !== "over") return;
      phase = "countdown";
      countdownStart = now;
      lastNow = now;
      killsA = 0;
      killsB = 0;
      winner = null;
      timeLeft = duration;
    },
    resetToMenu() {
      phase = "menu";
      killsA = 0;
      killsB = 0;
      winner = null;
      timeLeft = duration;
    },
    tick(now) {
      lastNow = now;
      if (phase === "countdown" && now - countdownStart >= countdownLen) {
        phase = "playing";
        playStart = countdownStart + countdownLen;
      }
      if (phase === "playing") {
        timeLeft = Math.max(0, duration - (now - playStart));
        if (timeLeft === 0 || killsA >= killsToWin || killsB >= killsToWin) finish();
      }
      return phase;
    },
    registerKill(team, now) {
      if (phase !== "playing") return false;
      lastNow = now;
      if (team === "A") killsA++;
      else killsB++;
      if (killsA >= killsToWin || killsB >= killsToWin) {
        timeLeft = Math.max(0, duration - (now - playStart));
        finish();
      }
      return true;
    },
    canAct() {
      return phase === "countdown" || phase === "playing";
    }
  };
}

// src/game/entities.ts
var RESPAWN_MS = 3e3;
function createEntity(id, pos, maxHp = 100, radius = 0.35, height = 1.7) {
  return {
    id,
    pos,
    radius,
    height,
    hp: maxHp,
    maxHp,
    alive: true,
    deadUntil: 0,
    invincibleUntil: 0
  };
}

// src/game/damage.ts
function applyDamage(e, dmg, now) {
  if (!e.alive || now < e.invincibleUntil) return false;
  e.hp = Math.max(0, e.hp - dmg);
  if (e.hp > 0) return false;
  e.alive = false;
  e.deadUntil = now + RESPAWN_MS;
  return true;
}

// src/game/objective.ts
var URGENT_MS = 3e4;
function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1e3));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}
function isClockUrgent(timeLeftMs, phase) {
  return (phase === "playing" || phase === "over") && timeLeftMs < URGENT_MS;
}
function isClockPulsing(timeLeftMs, phase) {
  return phase === "playing" && timeLeftMs < URGENT_MS;
}
function scorePlayerDeath(match, killed, now) {
  if (!killed || match.phase !== "playing") return false;
  return match.registerKill("B", now);
}

// src/game/objective.test.ts
var FAST = { teamKillsToWin: 3, durationMs: 6e4, countdownMs: 1e3 };
test("formatClock renders M:SS, rounding seconds up", () => {
  assert.equal(formatClock(5 * 6e4), "5:00");
  assert.equal(formatClock(299001), "5:00");
  assert.equal(formatClock(299e3), "4:59");
  assert.equal(formatClock(61e3), "1:01");
  assert.equal(formatClock(9500), "0:10");
  assert.equal(formatClock(1), "0:01");
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(-500), "0:00");
  assert.equal(formatClock(Number.NaN), "0:00");
  for (const ms of [0, 1, 999, 29999, 6e4, 299999, 3e5]) {
    assert.match(formatClock(ms), /^\d:\d\d$/);
  }
});
test("clock is urgent under 30s only in playing/over, and pulses only while playing", () => {
  assert.equal(isClockUrgent(URGENT_MS, "playing"), false);
  assert.equal(isClockUrgent(URGENT_MS - 1, "playing"), true);
  assert.equal(isClockUrgent(0, "over"), true);
  assert.equal(isClockUrgent(1e4, "countdown"), false);
  assert.equal(isClockUrgent(1e4, "menu"), false);
  assert.equal(isClockPulsing(1e4, "playing"), true);
  assert.equal(isClockPulsing(1e4, "over"), false);
  assert.equal(isClockPulsing(URGENT_MS + 1, "playing"), false);
});
test("a lethal hit scores exactly one kill for team B; hits on the corpse never add more", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  const p = createEntity("player", { x: 0, y: 0, z: 0 }, 200, 0.4, 1.6);
  const k1 = applyDamage(p, 50, 1100);
  assert.equal(scorePlayerDeath(m, k1, 1100), false, "non-lethal hit scored");
  assert.equal(m.killsB, 0);
  const k2 = applyDamage(p, 999, 1200);
  assert.equal(k2, true);
  assert.equal(scorePlayerDeath(m, k2, 1200), true);
  assert.equal(m.killsB, 1);
  for (let i = 0; i < 5; i++) {
    const again = applyDamage(p, 999, 1300 + i);
    assert.equal(again, false);
    scorePlayerDeath(m, again, 1300 + i);
  }
  assert.equal(m.killsB, 1, "dead player scored again");
});
test("player death outside playing never scores", () => {
  const m = createMatch(FAST);
  assert.equal(scorePlayerDeath(m, true, 0), false, "menu death scored");
  m.start(0);
  assert.equal(scorePlayerDeath(m, true, 500), false, "countdown death scored");
  m.tick(FAST.countdownMs + FAST.durationMs);
  assert.equal(m.phase, "over");
  assert.equal(scorePlayerDeath(m, true, FAST.countdownMs + FAST.durationMs + 1), false);
  assert.equal(m.killsB, 0);
});
