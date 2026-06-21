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

function c(x, y, state, number = null) {
  return { x, y, state, number };
}

function solve(cells, extra = {}) {
  return core.solveBoard({ cells, ...extra });
}

function keys(items) {
  return new Set(items.map((item) => core.keyOf(item.x, item.y)));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function highlight(cell, result, settings = { showProbabilities: false }, salt = "deadbeef") {
  return plain(
    core._private.getHighlightForCell(
      { ...cell, key: core.keyOf(cell.x, cell.y) },
      result,
      settings,
      salt
    )
  );
}

function fakeCell(id) {
  const classes = new Set();
  const attrs = {};
  return {
    id,
    classList: {
      add(cls) {
        classes.add(cls);
      },
      remove(cls) {
        classes.delete(cls);
      },
      contains(cls) {
        return classes.has(cls);
      },
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    getAttribute(name) {
      return attrs[name] || null;
    },
    _classes: classes,
  };
}

{
  const result = solve([c(0, 0, "open", 1), c(1, 0, "closed")]);
  assert.deepEqual(keys(result.mines), new Set(["1,0"]));
  assert.deepEqual(keys(result.safe), new Set());
  const explanation = result.explanations.get("1,0");
  assert.equal(explanation.conclusion, "mine");
  assert.equal(explanation.rule, "all-mines");
  assert.equal(explanation.constraint.origin.type, "number");
  assert.match(core._private.formatExplanation(explanation), /青色：当前格/);
  assert.match(core._private.formatExplanation(explanation), /橙色层约束/);
  assert.match(core._private.formatExplanationHtml(explanation), /msah-layer-text-focus/);
  assert.match(core._private.formatExplanationHtml(explanation), /msah-layer-text-1/);
}

{
  const result = solve([c(0, 0, "flag"), c(1, 0, "open", 1), c(2, 0, "closed")]);
  assert.deepEqual(keys(result.safe), new Set());
  assert.deepEqual(keys(result.mines), new Set());
}

{
  const result = solve([c(0, 0, "open", 0), c(1, 0, "closed")]);
  assert.deepEqual(keys(result.safe), new Set(["1,0"]));
  assert.deepEqual(keys(result.mines), new Set());
  const explanation = result.explanations.get("1,0");
  assert.equal(explanation.conclusion, "safe");
  assert.equal(explanation.rule, "all-safe");
  assert.equal(explanation.constraint.origin.type, "number");
  assert.match(core._private.formatExplanation(explanation), /剩余雷数为 0/);
}

{
  const result = solve([
    c(0, 0, "open", 1),
    c(1, 0, "closed"),
    c(2, 0, "closed"),
    c(0, 1, "open", 1),
    c(1, 1, "closed"),
    c(2, 1, "open", 1),
  ]);
  assert.equal(result.safeKeys.has("2,0"), true);
  const explanation = result.explanations.get("2,0");
  assert.equal(explanation.conclusion, "safe");
  assert.equal(explanation.constraint.origin.type, "difference");
  assert.match(core._private.formatExplanation(explanation), /颜色读法/);
  const related = core._private.collectExplanationKeys(explanation);
  assert.equal(related.peers.has("2,0"), true);
  assert.equal(related.sources.has("2,1"), true);
  assert.equal(related.layers.length, 2);
  assert.equal(related.layers[0].peers.has("2,0"), true);
  assert.equal(related.layers[1].sources.has("2,1"), true);
  assert.equal(related.layers[1].peers.size, 0);
  assert.match(core._private.formatExplanationHtml(explanation), /上|下|左|右|当前格/);
}

{
  const result = solve([
    c(0, 0, "closed"),
    c(1, 0, "open", 2),
    c(2, 0, "closed"),
    c(0, 1, "open", 1),
    c(1, 1, "closed"),
    c(2, 1, "open", 1),
    c(0, 2, "closed"),
    c(1, 2, "closed"),
    c(2, 2, "closed"),
  ]);
  assert.deepEqual(keys(result.mines), new Set(["0,0", "2,0"]));
  assert.deepEqual(keys(result.safe), new Set(["1,1", "0,2", "1,2", "2,2"]));
  const explanation = result.explanations.get("1,1");
  assert.equal(explanation.conclusion, "safe");
  assert.equal(explanation.rule, "exact");
  assert.equal(explanation.constraint.origin.type, "exact");
  assert.match(core._private.formatExplanation(explanation), /枚举读法/);
  assert.match(core._private.formatExplanationHtml(explanation), /精确枚举/);
}

{
  const cells = [
    c(0, 0, "open", 1),
    c(1, 0, "closed"),
    c(2, 0, "closed"),
    c(0, 1, "closed"),
    c(1, 1, "closed"),
    c(2, 1, "closed"),
  ];
  const result = solve(cells, { width: 3, height: 2, totalMines: 1 });
  assert.equal(result.safeKeys.has("2,0"), true);
  assert.equal(result.safeKeys.has("2,1"), true);
  assert.equal(result.mineKeys.size, 0);
  assert.equal(result.stats.global.enabled, true);
  assert.equal(result.stats.global.totalMines, 1);
  const explanation = result.explanations.get("2,0");
  assert.equal(explanation.conclusion, "safe");
  assert.equal(explanation.rule, "global");
  assert.equal(explanation.constraint.origin.type, "global");
  assert.match(core._private.formatExplanation(explanation), /全局读法/);
  assert.match(core._private.formatExplanationHtml(explanation), /全局雷数/);
}

{
  const result = solve(
    [c(0, 0, "closed"), c(1, 0, "closed"), c(2, 0, "closed")],
    { width: 3, height: 1, totalMines: 1 }
  );
  assert.equal(result.stats.global.enabled, true);
  assert.equal(result.probabilities.size, 0, "uninformed global average probabilities should stay hidden");
}

{
  assert.equal(core._private.relativeCellName("1,0", "1,1"), "上");
  assert.equal(core._private.relativeCellName("0,0", "1,1"), "上左");
  assert.equal(core._private.relativeCellName("2,2", "1,1"), "下右");
}

{
  const current = fakeCell("cell_2_0");
  const source = fakeCell("cell_2_1");
  const doc = {
    querySelectorAll() {
      return [current, source].filter((element) => element._classes.size > 0);
    },
    getElementById(id) {
      return id === "cell_2_0" ? current : id === "cell_2_1" ? source : null;
    },
  };
  const explanation = {
    key: "2,0",
    conclusion: "safe",
    constraint: {
      source: "2,1",
      cells: ["2,0"],
      count: 0,
      origin: { type: "number", source: "2,1", number: 1, knownMines: 1 },
    },
  };
  core._private.renderExplanationHighlights(doc, "deadbeef", current, explanation);
  assert.equal(current._classes.has("msah-deadbeef-explain-focus"), true);
  assert.equal(source._classes.has("msah-deadbeef-explain-layer-1"), true);
  assert.equal(current.getAttribute("data-msah-explain-label"), null);
  assert.equal(source.getAttribute("data-msah-explain-label"), null);
  core._private.clearHighlights(doc, "deadbeef");
  assert.equal(current.getAttribute("data-msah-explain-label"), null);
  assert.equal(source.getAttribute("data-msah-explain-label"), null);
}

{
  const result = solve([
    c(0, 0, "open", 1),
    c(1, 0, "closed"),
    c(2, 0, "closed"),
    c(0, 1, "open", 1),
    c(1, 1, "closed"),
    c(2, 1, "open", 2),
  ]);
  assert.equal(result.mineKeys.has("2,0"), true);
}

{
  const result = solve([
    c(0, 0, "open", 1),
    c(1, 0, "closed"),
    c(2, 0, "closed"),
    c(0, 1, "open", 0),
    c(1, 1, "open", 0),
    c(2, 1, "open", 1),
  ]);
  assert.equal(result.mineKeys.has("1,0"), false);
  assert.equal(result.safeKeys.has("1,0"), true);
  assert.equal(result.mineKeys.has("2,0"), false);
  assert.equal(result.safeKeys.has("2,0"), true);
}

{
  assert.deepEqual(plain(core.readCellStateFromClassNames("cell size24 hd_closed closed")), {
    state: "closed",
    number: null,
  });
  assert.deepEqual(plain(core.readCellStateFromClassNames("cell size24 hd_closed_flag closed_flag")), {
    state: "closed",
    number: null,
  });
  assert.deepEqual(plain(core.readCellStateFromClassNames("cell size24 hd_closed hd_flag flag")), {
    state: "flag",
    number: null,
  });
  assert.deepEqual(plain(core.readCellStateFromClassNames("cell size24 opened hd_type3")), {
    state: "open",
    number: 3,
  });
}

{
  const result = {
    safeKeys: new Set(),
    mineKeys: new Set(["1,0"]),
    probabilities: new Map([["2,0", 0.6]]),
  };

  assert.deepEqual(highlight(c(1, 0, "flag"), result, undefined, "abc12345"), {
    className: "msah-abc12345-flag-ok",
    label: null,
  });
  assert.deepEqual(highlight(c(2, 0, "flag"), result, undefined, "abc12345"), {
    className: "msah-abc12345-flag-q",
    label: "?",
  });
  assert.deepEqual(highlight(c(1, 0, "closed"), result, undefined, "abc12345"), {
    className: "msah-abc12345-mine",
    label: "M",
  });
  assert.deepEqual(
    highlight(c(2, 0, "closed"), result, { showProbabilities: true }, "abc12345"),
    {
      className: "msah-abc12345-prob",
      label: "60%",
    }
  );
}

console.log("solver tests passed");
