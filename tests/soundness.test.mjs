import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../minesweeper-online-helper.user.js", import.meta.url), "utf8");
const context = {
  window: {},
  console,
};

vm.createContext(context);
vm.runInContext(source, context, { filename: "minesweeper-online-helper.user.js" });

const core = context.window.MinesweeperAssistantCore;

function idxToCell(index, width) {
  return { x: index % width, y: Math.floor(index / width) };
}

function bit(mask, index) {
  return (mask & (1 << index)) !== 0;
}

function bitCount(mask) {
  let count = 0;
  for (let rest = mask; rest > 0; rest >>>= 1) {
    count += rest & 1;
  }
  return count;
}

function key(index, width) {
  const { x, y } = idxToCell(index, width);
  return core.keyOf(x, y);
}

function neighbors(index, width, height) {
  const { x, y } = idxToCell(index, width);
  const result = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      result.push(ny * width + nx);
    }
  }
  return result;
}

function mineCount(mask, index, width, height) {
  return neighbors(index, width, height).filter((neighbor) => bit(mask, neighbor)).length;
}

function makeCells(width, height, actualMineMask, openMask, flagMask) {
  const cells = [];
  for (let index = 0; index < width * height; index += 1) {
    const { x, y } = idxToCell(index, width);
    if (bit(openMask, index)) {
      cells.push({ x, y, state: "open", number: mineCount(actualMineMask, index, width, height) });
    } else if (bit(flagMask, index)) {
      cells.push({ x, y, state: "flag", number: null });
    } else {
      cells.push({ x, y, state: "closed", number: null });
    }
  }
  return cells;
}

function isConsistent(mask, width, height, cells, totalMines = null) {
  if (Number.isInteger(totalMines) && bitCount(mask) !== totalMines) return false;
  for (const cell of cells) {
    if (cell.state !== "open") continue;
    const index = cell.y * width + cell.x;
    if (bit(mask, index)) return false;
    if (mineCount(mask, index, width, height) !== cell.number) return false;
  }
  return true;
}

function forcedSets(width, height, cells, totalMines = null) {
  const limit = 1 << (width * height);
  const consistent = [];
  for (let mask = 0; mask < limit; mask += 1) {
    if (isConsistent(mask, width, height, cells, totalMines)) consistent.push(mask);
  }

  const forcedMines = new Set();
  const forcedSafe = new Set();
  if (consistent.length === 0) return { forcedMines, forcedSafe, consistentCount: 0 };

  for (let index = 0; index < width * height; index += 1) {
    if (consistent.every((mask) => bit(mask, index))) forcedMines.add(key(index, width));
    if (consistent.every((mask) => !bit(mask, index))) forcedSafe.add(key(index, width));
  }

  return { forcedMines, forcedSafe, consistentCount: consistent.length };
}

function signature(cells) {
  return cells.map((cell) => `${cell.state}:${cell.number ?? ""}`).join("|");
}

function assertSound(width, height, cells, totalMines = null) {
  const result = core.solveBoard({ width, height, cells, ...(Number.isInteger(totalMines) ? { totalMines } : {}) });
  const { forcedMines, forcedSafe, consistentCount } = forcedSets(width, height, cells, totalMines);
  assert.notEqual(consistentCount, 0);

  for (const mineKey of result.mineKeys) {
    assert.equal(
      forcedMines.has(mineKey),
      true,
      `false mine ${mineKey} on ${signature(cells)} total=${totalMines ?? "unknown"}`
    );
  }

  for (const safeKey of result.safeKeys) {
    assert.equal(
      forcedSafe.has(safeKey),
      true,
      `false safe ${safeKey} on ${signature(cells)} total=${totalMines ?? "unknown"}`
    );
  }
}

function checkNoFlagBoards3x3() {
  const width = 3;
  const height = 3;
  const limit = 1 << (width * height);
  const seen = new Set();
  const seenGlobal = new Set();
  let checked = 0;
  let checkedGlobal = 0;

  for (let actualMineMask = 0; actualMineMask < limit; actualMineMask += 1) {
    const totalMines = bitCount(actualMineMask);
    const safeMask = (limit - 1) & ~actualMineMask;
    for (let openMask = safeMask; ; openMask = (openMask - 1) & safeMask) {
      const cells = makeCells(width, height, actualMineMask, openMask, 0);
      const id = signature(cells);
      if (!seen.has(id)) {
        seen.add(id);
        assertSound(width, height, cells);
        checked += 1;
      }
      const globalId = `${id}|m=${totalMines}`;
      if (!seenGlobal.has(globalId)) {
        seenGlobal.add(globalId);
        assertSound(width, height, cells, totalMines);
        checkedGlobal += 1;
      }
      if (openMask === 0) break;
    }
  }

  return { checked, checkedGlobal };
}

function checkFlagBoards2x3() {
  const width = 3;
  const height = 2;
  const limit = 1 << (width * height);
  const seen = new Set();
  const seenGlobal = new Set();
  let checked = 0;
  let checkedGlobal = 0;

  for (let actualMineMask = 0; actualMineMask < limit; actualMineMask += 1) {
    const totalMines = bitCount(actualMineMask);
    const safeMask = (limit - 1) & ~actualMineMask;
    for (let openMask = safeMask; ; openMask = (openMask - 1) & safeMask) {
      const hiddenMask = (limit - 1) & ~openMask;
      for (let flagMask = hiddenMask; ; flagMask = (flagMask - 1) & hiddenMask) {
        const cells = makeCells(width, height, actualMineMask, openMask, flagMask);
        const id = signature(cells);
        if (!seen.has(id)) {
          seen.add(id);
          assertSound(width, height, cells);
          checked += 1;
        }
        const globalId = `${id}|m=${totalMines}`;
        if (!seenGlobal.has(globalId)) {
          seenGlobal.add(globalId);
          assertSound(width, height, cells, totalMines);
          checkedGlobal += 1;
        }
        if (flagMask === 0) break;
      }
      if (openMask === 0) break;
    }
  }

  return { checked, checkedGlobal };
}

const noFlag = checkNoFlagBoards3x3();
const flag = checkFlagBoards2x3();

console.log(
  `soundness tests passed (${noFlag.checked + flag.checked} views, ` +
    `${noFlag.checkedGlobal + flag.checkedGlobal} global views)`
);
