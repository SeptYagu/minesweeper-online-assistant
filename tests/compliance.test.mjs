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

function makeFakeStore() {
  const data = new Map();
  return {
    getItem(k) {
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      data.set(k, String(v));
    },
    removeItem(k) {
      data.delete(k);
    },
    has(k) {
      return data.has(k);
    },
    _data: data,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFakeDoc() {
  const byId = new Map();

  const make = (tag) => {
    const el = {
      tag,
      id: "",
      _classes: new Set(),
      _innerHTML: "",
      _attrs: {},
      children: [],
      dataset: {},
      style: {},
      textContent: "",
      title: "",
      checked: false,
      value: "",
    };
    Object.defineProperty(el, "classList", {
      get() {
        return {
          add(...c) {
            for (const x of c) el._classes.add(x);
          },
          remove(...c) {
            for (const x of c) el._classes.delete(x);
          },
          contains(c) {
            return el._classes.has(c);
          },
        };
      },
    });
    Object.defineProperty(el, "innerHTML", {
      get() {
        return el._innerHTML;
      },
      set(v) {
        el._innerHTML = v;
      },
    });
    el.appendChild = (child) => {
      el.children.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    };
    el.removeAttribute = (name) => {
      delete el._attrs[name];
    };
    el.setAttribute = (name, value) => {
      el._attrs[name] = String(value);
    };
    el.getAttribute = (name) => (name in el._attrs ? el._attrs[name] : null);
    el.querySelector = () => make("input");
    el.querySelectorAll = (sel) => {
      const wanted = new Set();
      for (const part of sel.split(",").map((s) => s.trim())) {
        if (part.startsWith(".")) wanted.add(part.slice(1));
      }
      const out = [];
      const visit = (n) => {
        for (const c of n.children) {
          if (wanted.size > 0) {
            for (const cls of wanted) {
              if (c._classes && c._classes.has(cls)) out.push(c);
            }
          }
          visit(c);
        }
      };
      visit(el);
      return out;
    };
    return el;
  };

  const head = make("head");
  const body = make("body");
  return {
    head,
    body,
    createElement: (tag) => make(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (sel) => {
      const wanted = new Set();
      for (const part of sel.split(",").map((s) => s.trim())) {
        if (part.startsWith(".")) wanted.add(part.slice(1));
      }
      const out = [];
      const visit = (n) => {
        for (const c of n.children) {
          if (wanted.size > 0) {
            for (const cls of wanted) {
              if (c._classes && c._classes.has(cls)) out.push(c);
            }
          }
          visit(c);
        }
      };
      visit(body);
      visit(head);
      return out;
    },
  };
}

{
  const r = mulberry32(42);
  const s1 = core._private.getInstallSalt(null, r);
  assert.equal(/^[0-9a-f]{8}$/.test(s1), true);
  assert.equal(
    core._private.getInstallSalt(null, () => 1),
    "ffffffff",
    "salt generation should clamp random=1 to ff bytes"
  );

  const store = makeFakeStore();
  const r2 = mulberry32(42);
  const a = core._private.getInstallSalt(store, r2);
  const b = core._private.getInstallSalt(store, mulberry32(42));
  assert.equal(a, b, "same random seed should give same salt");
  assert.equal(store.has("__msah_salt"), true, "salt should be persisted");
  assert.equal(store.getItem("__msah_salt"), a);

  const r3 = mulberry32(43);
  const c = core._private.getInstallSalt(null, r3);
  assert.notEqual(a, c, "different seed should give different salt");
}

{
  const key = core._private.getStorageKey("deadbeef");
  assert.equal(key, "msah-deadbeef-cfg");
  assert.equal(/^msah-[0-9a-f]{8}-cfg$/.test(key), true);
}

{
  const store = makeFakeStore();
  store.setItem(
    "minesweeper-online-assistant-settings-v1",
    JSON.stringify({
      auto: false,
      showProbabilities: true,
      collapsed: true,
      actionDelayMs: 200,
      randomDelayEnabled: true,
      automationAcknowledged: true,
    })
  );
  const salt = "cafebabe";
  const whitelist = core._private.migrateSettings(store, salt);
  assert.deepEqual(JSON.parse(JSON.stringify(whitelist)), {
    auto: false,
    showProbabilities: true,
    showExplanations: true,
    collapsed: true,
  });
  const stored = JSON.parse(store.getItem("msah-cafebabe-cfg"));
  assert.deepEqual(stored, { auto: false, showProbabilities: true, showExplanations: true, collapsed: true });
  assert.equal(
    Object.prototype.hasOwnProperty.call(stored, "actionDelayMs"),
    false,
    "actionDelayMs should not appear in new key"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(stored, "randomDelayEnabled"),
    false,
    "randomDelayEnabled should not appear in new key"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(stored, "automationAcknowledged"),
    false,
    "automationAcknowledged should not appear in new key"
  );
  assert.equal(store.getItem("minesweeper-online-assistant-settings-v1"), null);

  const noop = core._private.migrateSettings(store, salt);
  assert.equal(noop, null);
}

{
  const store = makeFakeStore();
  store.setItem("minesweeper-online-assistant-settings-v1", "not-json");
  const result = core._private.migrateSettings(store, "deadbeef");
  assert.equal(result, null);
  assert.equal(store.getItem("minesweeper-online-assistant-settings-v1"), null);
}

{
  const store = makeFakeStore();
  const existing = { auto: false, showProbabilities: false, showExplanations: false, collapsed: true };
  store.setItem("msah-deadbeef-cfg", JSON.stringify(existing));
  store.setItem(
    "minesweeper-online-assistant-settings-v1",
    JSON.stringify({ auto: true, showProbabilities: true, collapsed: false })
  );
  const result = core._private.migrateSettings(store, "deadbeef");
  assert.equal(result, null, "migration should not overwrite an existing salted settings key");
  assert.deepEqual(JSON.parse(store.getItem("msah-deadbeef-cfg")), existing);
  assert.equal(store.getItem("minesweeper-online-assistant-settings-v1"), null);
}

{
  const store = makeFakeStore();
  core._private.saveSettings("deadbeef", { auto: true, showProbabilities: true, showExplanations: false, collapsed: false }, store);
  const raw = store.getItem("msah-deadbeef-cfg");
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, { auto: true, showProbabilities: true, showExplanations: false, collapsed: false });

  const loaded = core._private.loadSettings("deadbeef", store);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), {
    auto: true,
    showProbabilities: true,
    showExplanations: false,
    collapsed: false,
  });

  const store2 = makeFakeStore();
  const def = core._private.loadSettings("deadbeef", store2);
  assert.deepEqual(JSON.parse(JSON.stringify(def)), {
    auto: true,
    showProbabilities: false,
    showExplanations: true,
    collapsed: false,
  });
}

{
  const doc = makeFakeDoc();
  const settings = { auto: true, showProbabilities: false, collapsed: false };
  const panel = core._private.createPanel(settings, "abc12345", doc);
  const html = panel._innerHTML;
  assert.equal(panel.id, "msah-panel-abc12345");
  for (const forbidden of [
    "open-safe",
    "flag-mines",
    "automation",
    "random-delay",
    "msah-speed",
    "requires-consent",
    "data-msah-label",
    "MIN_ACTION_DELAY_MS",
    "MAX_ACTION_DELAY_MS",
  ]) {
    assert.equal(
      html.includes(forbidden),
      false,
      `panel HTML should not contain "${forbidden}"`
    );
  }
  assert.equal(html.includes("data-msah-note"), true, "panel should keep a note block");
  assert.equal(html.includes("data-msah-option=\"explanations\""), true, "panel should include explanation toggle");
  assert.equal(html.includes("aria-label"), false, "panel should not reference data-* label attributes");
}

{
  const names = core._private.getHighlightClassNames("deadbeef");
  assert.equal(names.safe, "msah-deadbeef-safe");
  assert.equal(names.mine, "msah-deadbeef-mine");
  assert.equal(names.prob, "msah-deadbeef-prob");
  assert.equal(names.flagOk, "msah-deadbeef-flag-ok");
  assert.equal(names.flagQ, "msah-deadbeef-flag-q");
  assert.deepEqual(JSON.parse(JSON.stringify(names.explainLayers)), [
    "msah-deadbeef-explain-layer-1",
    "msah-deadbeef-explain-layer-2",
    "msah-deadbeef-explain-layer-3",
    "msah-deadbeef-explain-layer-4",
    "msah-deadbeef-explain-layer-5",
  ]);
}

{
  assert.equal(
    core._private.classTokensWithoutAssistantClasses(
      "cell opened hd_type1 msah-deadbeef-safe msah-deadbeef-explain-focus",
      "deadbeef"
    ),
    "cell hd_type1 opened"
  );
  assert.equal(
    core._private.isAssistantOnlyClassMutation(
      {
        type: "attributes",
        attributeName: "class",
        oldValue: "cell opened hd_type1 msah-deadbeef-safe",
        target: { className: "cell opened hd_type1 msah-deadbeef-safe msah-deadbeef-explain-focus" },
      },
      "deadbeef"
    ),
    true,
    "assistant-only highlight class changes should not trigger re-analysis"
  );
  assert.equal(
    core._private.isAssistantOnlyClassMutation(
      {
        type: "attributes",
        attributeName: "class",
        oldValue: "cell closed msah-deadbeef-safe",
        target: { className: "cell opened hd_type1 msah-deadbeef-safe" },
      },
      "deadbeef"
    ),
    false,
    "real board class changes must still trigger re-analysis"
  );
}

{
  const staleCell = {
    id: "cell_0_0",
    dataset: {},
    classList: ["cell", "opened", "hd_type1"],
  };
  const liveCell = {
    id: "cell_1_0",
    dataset: {},
    classList: ["cell", "hd_closed"],
  };
  const areaBlock = {
    querySelectorAll(selector) {
      assert.equal(selector, "div.cell[id^='cell_']");
      return [liveCell];
    },
  };
  const doc = {
    getElementById(id) {
      return id === "AreaBlock" ? areaBlock : null;
    },
    querySelectorAll() {
      return [staleCell, liveCell];
    },
  };
  const board = core._private.readBoardFromDom(doc);
  assert.equal(board.cells.length, 1, "board reader should be scoped to #AreaBlock when present");
  assert.equal(board.cells[0].key, "1,0");
}

{
  assert.equal(
    core._private.isAnalysisShortcut({
      code: "Backquote",
      key: "`",
      target: { tagName: "body" },
    }),
    true
  );
  for (const key of ["~", "～", "·"]) {
    assert.equal(
      core._private.isAnalysisShortcut({
        code: "",
        key,
        target: { tagName: "body" },
      }),
      true,
      `shortcut should accept key "${key}"`
    );
  }
  assert.equal(
    core._private.isAnalysisShortcut({
      code: "",
      key: "Process",
      keyCode: 192,
      target: { tagName: "body" },
    }),
    true,
    "shortcut should accept legacy keyCode 192"
  );
  assert.equal(
    core._private.isAnalysisShortcut({
      code: "Backquote",
      key: "`",
      target: { tagName: "input", type: "text" },
    }),
    false,
    "shortcut should not fire while editing input fields"
  );
  assert.equal(
    core._private.isAnalysisShortcut({
      code: "Backquote",
      key: "`",
      target: { tagName: "input", type: "checkbox" },
    }),
    true,
    "shortcut should still fire when focus remains on option checkboxes"
  );
  assert.equal(
    core._private.isAnalysisShortcut({
      code: "Tab",
      key: "Tab",
      target: { tagName: "body" },
    }),
    false
  );
}

{
  assert.equal(core._private.shouldAutoAnalyze({ auto: true }, true), true);
  assert.equal(
    core._private.shouldAutoAnalyze({ auto: true }, false),
    false,
    "auto should not re-enable analysis after shortcut/clear hides it"
  );
  assert.equal(core._private.shouldAutoAnalyze({ auto: false }, true), false);
}

{
  const result = {
    safeKeys: new Set(["0,0"]),
    mineKeys: new Set(["1,0"]),
    probabilities: new Map(),
  };
  const cell = { key: "0,0", state: "closed" };
  const h = core._private.getHighlightForCell(cell, result, {}, "deadbeef");
  assert.deepEqual(JSON.parse(JSON.stringify(h)), {
    className: "msah-deadbeef-safe",
    label: "OK",
  });

  const flagOk = { key: "1,0", state: "flag" };
  const f1 = core._private.getHighlightForCell(flagOk, result, {}, "deadbeef");
  assert.deepEqual(JSON.parse(JSON.stringify(f1)), {
    className: "msah-deadbeef-flag-ok",
    label: null,
  });

  const flagQ = { key: "2,2", state: "flag" };
  const f2 = core._private.getHighlightForCell(flagQ, result, {}, "deadbeef");
  assert.deepEqual(JSON.parse(JSON.stringify(f2)), {
    className: "msah-deadbeef-flag-q",
    label: "?",
  });

  const mine = { key: "1,0", state: "closed" };
  const m = core._private.getHighlightForCell(mine, result, {}, "deadbeef");
  assert.deepEqual(JSON.parse(JSON.stringify(m)), {
    className: "msah-deadbeef-mine",
    label: "M",
  });
}

{
  const doc = makeFakeDoc();
  const result = {
    safeKeys: new Set(["0,0"]),
    mineKeys: new Set(["1,0"]),
    probabilities: new Map(),
  };
  const fakeCell = doc.createElement("div");
  const cell = { key: "0,0", state: "closed", element: fakeCell };
  const board = { cells: [cell] };
  core._private.renderHighlights(board, result, { showProbabilities: false }, doc, "deadbeef");
  assert.equal(
    fakeCell.getAttribute("aria-label"),
    "OK",
    "renderHighlights should write aria-label"
  );
  assert.equal(
    fakeCell.getAttribute("data-msah-label"),
    null,
    "renderHighlights should not write data-msah-label"
  );
  assert.equal(
    fakeCell._classes.has("msah-deadbeef-safe"),
    true,
    "renderHighlights should add salt-prefixed safe class"
  );
}

{
  const doc = makeFakeDoc();
  const result = {
    safeKeys: new Set(["0,0"]),
    mineKeys: new Set(),
    probabilities: new Map(),
  };
  const fakeCell = doc.createElement("div");
  fakeCell.setAttribute("aria-label", "original site label");
  doc.body.appendChild(fakeCell);
  const board = { cells: [{ key: "0,0", state: "closed", element: fakeCell }] };

  core._private.renderHighlights(board, result, { showProbabilities: false }, doc, "deadbeef");
  assert.equal(fakeCell.getAttribute("aria-label"), "OK");
  core._private.clearHighlights(doc, "deadbeef");
  assert.equal(
    fakeCell.getAttribute("aria-label"),
    "original site label",
    "clearHighlights should restore the site's original aria-label"
  );
}

console.log("compliance tests passed");
