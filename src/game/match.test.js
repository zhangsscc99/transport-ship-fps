// src/game/match.test.ts
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

// src/game/match.test.ts
var FAST = { teamKillsToWin: 3, durationMs: 6e4, countdownMs: 1e3 };
test("a fresh match sits in menu with zeroed counters", () => {
  const m = createMatch();
  assert.equal(m.phase, "menu");
  assert.equal(m.killsA, 0);
  assert.equal(m.killsB, 0);
  assert.equal(m.winner, null);
  assert.equal(m.timeLeftMs, 5 * 6e4);
  assert.equal(m.canAct(0), false);
});
test("killsToWin exposes the win target (default 25, overridable, read-only)", () => {
  assert.equal(createMatch().killsToWin, 25);
  const m = createMatch(FAST);
  assert.equal(m.killsToWin, FAST.teamKillsToWin);
  assert.throws(() => {
    m.killsToWin = 99;
  }, TypeError);
  assert.equal(m.killsToWin, FAST.teamKillsToWin);
});
test("timeLeftMs freezes once the match is over (by kills) and ticks no longer advance it", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  m.tick(FAST.countdownMs + 1e4);
  for (let i = 0; i < FAST.teamKillsToWin; i++) m.registerKill("A", FAST.countdownMs + 1e4);
  assert.equal(m.phase, "over");
  const frozen = m.timeLeftMs;
  assert.equal(frozen, FAST.durationMs - 1e4);
  m.tick(FAST.countdownMs + 3e4);
  m.tick(FAST.countdownMs + 9e4);
  assert.equal(m.timeLeftMs, frozen);
});
test("start() enters the countdown; it is a no-op while running", () => {
  const m = createMatch(FAST);
  m.start(1e3);
  assert.equal(m.phase, "countdown");
  assert.equal(m.countdownLeftMs, 1e3);
  m.start(1500);
  m.tick(1500);
  assert.equal(m.countdownLeftMs, 500);
});
test("the countdown rolls into playing after countdownMs", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(999);
  assert.equal(m.phase, "countdown");
  m.tick(1e3);
  assert.equal(m.phase, "playing");
  assert.equal(m.timeLeftMs, FAST.durationMs);
});
test("canAct is true during countdown and playing, false in menu and over", () => {
  const m = createMatch(FAST);
  assert.equal(m.canAct(0), false);
  m.start(0);
  m.tick(100);
  assert.equal(m.canAct(100), true);
  m.tick(FAST.countdownMs);
  assert.equal(m.canAct(FAST.countdownMs), true);
  for (let i = 0; i < FAST.teamKillsToWin; i++) m.registerKill("A", 1100 + i);
  assert.equal(m.phase, "over");
  assert.equal(m.canAct(9999), false);
});
test("registerKill is ignored in menu and countdown", () => {
  const m = createMatch(FAST);
  assert.equal(m.registerKill("A", 0), false);
  m.start(0);
  assert.equal(m.registerKill("A", 500), false, "countdown kill counted");
  assert.equal(m.killsA, 0);
  m.tick(FAST.countdownMs);
  assert.equal(m.registerKill("A", FAST.countdownMs), true);
  assert.equal(m.killsA, 1);
});
test("reaching teamKillsToWin ends the match with that team winning", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  m.registerKill("B", 1100);
  m.registerKill("B", 1200);
  assert.equal(m.phase, "playing");
  m.registerKill("B", 1300);
  assert.equal(m.phase, "over");
  assert.equal(m.winner, "B");
  assert.equal(m.killsB, 3);
});
test("time-up picks the higher-kill team", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  m.registerKill("A", 1100);
  m.registerKill("A", 1200);
  m.registerKill("B", 1300);
  m.tick(FAST.countdownMs + FAST.durationMs);
  assert.equal(m.phase, "over");
  assert.equal(m.winner, "A");
});
test("a tie at time-up is a draw", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  m.registerKill("A", 1100);
  m.registerKill("B", 1200);
  m.tick(FAST.countdownMs + FAST.durationMs + 1);
  assert.equal(m.phase, "over");
  assert.equal(m.winner, "draw");
});
test("kills after over are ignored", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  for (let i = 0; i < FAST.teamKillsToWin; i++) m.registerKill("A", 1100 + i);
  assert.equal(m.phase, "over");
  assert.equal(m.registerKill("B", 2e3), false);
  assert.equal(m.killsB, 0);
});
test("timeLeftMs never goes negative", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs + FAST.durationMs + 5e4);
  assert.equal(m.phase, "over");
  assert.equal(m.timeLeftMs, 0);
});
test("repeated ticks at the same timestamp change nothing", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(500);
  m.tick(500);
  m.tick(500);
  assert.equal(m.phase, "countdown");
  assert.equal(m.countdownLeftMs, 500);
  m.tick(FAST.countdownMs);
  assert.equal(m.phase, "playing");
  m.tick(FAST.countdownMs);
  assert.equal(m.timeLeftMs, FAST.durationMs);
});
test("start() from over resets the counters and runs the countdown again", () => {
  const m = createMatch(FAST);
  m.start(0);
  m.tick(FAST.countdownMs);
  for (let i = 0; i < FAST.teamKillsToWin; i++) m.registerKill("A", 1100 + i);
  assert.equal(m.phase, "over");
  m.start(1e4);
  assert.equal(m.phase, "countdown");
  assert.equal(m.killsA, 0);
  assert.equal(m.killsB, 0);
  assert.equal(m.winner, null);
  assert.equal(m.timeLeftMs, FAST.durationMs);
});
