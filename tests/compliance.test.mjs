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
  const store = makeFakeStore();
  assert.equal(core._private.getRescueStorageKey("deadbeef", "42"), "msah-deadbeef-rescue-42");
  assert.deepEqual(JSON.parse(JSON.stringify(core._private.loadRescueUsage("deadbeef", "42", store))), {
    used: 0,
    keys: [],
  });

  let result = core._private.recordRescueUse("deadbeef", "42", "0,0", store);
  assert.equal(result.ok, true);
  assert.equal(result.counted, true);
  assert.equal(core._private.getRescueRemaining(result.usage), 2);

  result = core._private.recordRescueUse("deadbeef", "42", "0,0", store);
  assert.equal(result.ok, true);
  assert.equal(result.counted, false, "same target should not consume another rescue");

  core._private.recordRescueUse("deadbeef", "42", "0,1", store);
  core._private.recordRescueUse("deadbeef", "42", "0,2", store);
  result = core._private.recordRescueUse("deadbeef", "42", "0,3", store);
  assert.equal(result.ok, false, "a game should allow at most three rescue targets");
  assert.equal(core._private.loadRescueUsage("deadbeef", "42", store).used, 3);
}

{
  const state = core._private.createRescueState();
  const source = core._private.captureRescueGameInit(state, [
    { id: 77, sizeX: 2, sizeY: 2, mines: 1 },
    { t: [0, 10, 1, 0], o: [0, 0, 1, 0], f: [0, 0, 0, 0] },
    [],
    [],
    null,
    null,
    0,
    0,
    0,
    0,
  ]);
  assert.equal(source.available, true);
  assert.equal(state.currentGameId, "77");
  assert.deepEqual(JSON.parse(JSON.stringify(core._private.getRescueAnswerFromSource(source, "0,1"))), {
    key: "0,1",
    isMine: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(core._private.getRescueAnswerFromSource(source, "1,0"))), {
    key: "1,0",
    isMine: false,
  });

  core._private.captureRescueTouchUpdate(state, [1, "77", { touchCells: [1, 1, 12, 3, 0] }, null, false, null]);
  assert.equal(source.types[3], 3);
  assert.equal(source.opened[3], 1);

  core._private.captureRescueTouchUpdate(state, [1, "77", { touchCells: [0, 1, 13, 0, 1] }, null, false, null]);
  assert.equal(source.flags[1], 1);
  assert.equal(source.lastMarkedKey, "0,1");
  core._private.captureRescueTouchUpdate(state, [1, "77", { touchCells: [0, 1, 13, 0, 0] }, null, false, null]);
  assert.equal(source.flags[1], 0);
  assert.equal(source.lastMarkedKey, null);
}

{
  const fakeWindow = {};
  fakeWindow.$abc = Array.from({ length: 9 }, () => () => 0);
  const state = core._private.getRescueState(fakeWindow);
  const meta = { id: 123, sizeX: 2, sizeY: 2, mines: 1, level: 1, server: "", lpe: "abc" };
  const types = [0, 10, 1, 0];
  const prefixLength = Math.trunc(((Number(meta.id) % 1000) / 300) * types.length);
  const encodedChars = new Array(prefixLength + types.length).fill("x");
  for (let i = 0; i < types.length; i += 1) {
    encodedChars[prefixLength + types.length - (i + 1)] = String.fromCharCode(types[i]);
  }
  const source = core._private.captureRescueGameInit(state, [
    meta,
    { t: [0, 0, 0, 0], o: [0, 0, 0, 0], f: [0, 0, 0, 0] },
    [],
    [],
    null,
    encodedChars.join(""),
    0,
    0,
    0,
    13,
  ]);
  assert.equal(source.available, true);
  assert.equal(source.reason, "");
  assert.deepEqual(JSON.parse(JSON.stringify(source.types)), types);
  assert.equal(core._private.getRescueSourceStatus(fakeWindow, { width: 2, height: 2 }).ok, true);
}

{
  const fakeWindow = {};
  const state = core._private.getRescueState(fakeWindow);
  const source = core._private.captureRescueGameInit(state, [
    { id: 78, sizeX: 2, sizeY: 2, mines: 1, level: 1, server: "", lpe: "missing" },
    { t: [0, 0, 0, 0], o: [0, 0, 0, 0], f: [0, 0, 0, 0] },
    [],
    [],
    null,
    "xxxx",
    0,
    0,
    0,
    13,
  ]);
  const status = core._private.getRescueSourceStatus(fakeWindow, { width: 2, height: 2 });
  assert.equal(source.available, false);
  assert.equal(core._private.findRescueSourceCandidate(fakeWindow, { width: 2, height: 2 }), source);
  assert.equal(core._private.findMatchingRescueSource(fakeWindow, { width: 2, height: 2 }), null);
  assert.equal(status.ok, false);
  assert.equal(status.reason, "加密雷图未解码");
  assert.match(core._private.getRescueSourceStatus({}, { width: 2, height: 2 }).reason, /未捕获/);
}

{
  const state = core._private.createRescueState();
  const source = core._private.captureRescueGameInit(state, [
    { id: 88, sizeX: 2, sizeY: 1, mines: 1 },
    { t: [10, 0], o: [0, 0], f: [0, 0] },
  ]);
  assert.equal(source.available, true);
  core._private.captureRescueClickRequest(state, [
    "GameplayController.gameClickWsAction",
    [1, "88", 0, 0, 0, 1, "", null, null],
    0,
    980,
  ]);
  assert.equal(source.available, false);
  assert.equal(source.trusted, false);
}

{
  const fakeWindow = {};
  const state = core._private.installRescueSocketCapture(fakeWindow);
  const socket = {
    on(eventName, handler) {
      this.eventName = eventName;
      this.handler = handler;
    },
    emit() {},
  };
  fakeWindow.io = {
    connect() {
      return socket;
    },
  };
  const connected = fakeWindow.io.connect("wss://example.invalid");
  connected.on("response", () => {});
  connected.handler([
    0,
    999,
    [{ id: 99, sizeX: 1, sizeY: 1, mines: 1 }, { t: [10], o: [0], f: [0] }],
  ]);
  assert.equal(state.boards["99"].available, true);
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
  assert.equal(html.includes("当前悬停格"), false, "rescue should no longer depend on hover targeting");
  assert.equal(html.includes("问号标记"), false, "rescue copy should not rely on unavailable site question marks");
  assert.equal(html.includes("临时旗标记"), true, "rescue should target a temporary flag mark");
  assert.equal(html.includes("aria-label"), false, "panel should not reference data-* label attributes");
}

{
  const names = core._private.getHighlightClassNames("deadbeef");
  assert.equal(names.safe, "msah-deadbeef-safe");
  assert.equal(names.mine, "msah-deadbeef-mine");
  assert.equal(names.prob, "msah-deadbeef-prob");
  assert.equal(names.flagOk, "msah-deadbeef-flag-ok");
  assert.equal(names.flagQ, "msah-deadbeef-flag-q");
  assert.equal(names.rescueSafe, "msah-deadbeef-rescue-safe");
  assert.equal(names.rescueMine, "msah-deadbeef-rescue-mine");
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
  assert.equal(
    core._private.isRelevantAutoAnalyzeMutation(
      {
        type: "attributes",
        attributeName: "class",
        oldValue: "cell opened hd_type1 msah-deadbeef-safe",
        target: { className: "cell opened hd_type1 msah-deadbeef-safe msah-deadbeef-explain-focus" },
      },
      "deadbeef"
    ),
    false,
    "assistant-only class mutations should not trigger auto analysis"
  );
  assert.equal(
    core._private.isRelevantAutoAnalyzeMutation(
      {
        type: "childList",
        target: { nodeType: 1, id: "content" },
        addedNodes: [{ nodeType: 1, id: "AreaBlock" }],
        removedNodes: [],
      },
      "deadbeef"
    ),
    true,
    "replacing or inserting AreaBlock should trigger auto analysis"
  );
  assert.equal(
    core._private.isRelevantAutoAnalyzeMutation(
      {
        type: "childList",
        target: { nodeType: 1, id: "msah-panel-deadbeef" },
        addedNodes: [{ nodeType: 3 }],
        removedNodes: [],
      },
      "deadbeef"
    ),
    false,
    "unrelated assistant panel child changes should not trigger auto analysis"
  );
}

{
  const body = { nodeType: 1, id: "body" };
  const area = { nodeType: 1, id: "AreaBlock" };
  const doc = {
    body,
    getElementById(id) {
      return id === "AreaBlock" ? area : null;
    },
  };
  const targets = core._private.getAutoAnalyzeObserverTargets(doc);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].target, body, "body should be watched for board root replacement");
  assert.equal(targets[0].options.childList, true);
  assert.equal(targets[0].options.subtree, true);
  assert.equal(targets[1].target, area, "AreaBlock should still be watched for cell class changes");
  assert.equal(targets[1].options.attributes, true);
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
  const digits = {
    top_area_mines_100: { className: "top-area-num0 top-area-num" },
    top_area_mines_10: { className: "top-area-num0 top-area-num" },
    top_area_mines_1: { className: "top-area-num2 top-area-num" },
  };
  const doc = {
    getElementById(id) {
      return digits[id] || null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const board = {
    cells: [{ state: "flag" }, { state: "closed" }, { state: "closed" }],
  };
  assert.equal(core._private.readRemainingMinesFromDom(doc), 2);
  assert.equal(core._private.readTotalMinesFromDom(doc, board), 3);
}

{
  const cappedDigits = {
    top_area_mines_100: { className: "top-area-num9 top-area-num" },
    top_area_mines_10: { className: "top-area-num9 top-area-num" },
    top_area_mines_1: { className: "top-area-num9 top-area-num" },
  };
  const hintedDigits = {
    top_area_mines_100: { className: "top-area-num0 top-area-num" },
    top_area_mines_10: { className: "top-area-num0 top-area-num" },
    top_area_mines_1: { className: "top-area-num2 top-area-num" },
  };
  const board = { cells: [{ state: "closed" }, { state: "closed" }] };
  assert.equal(
    core._private.readTotalMinesFromDom(
      {
        getElementById(id) {
          return cappedDigits[id] || null;
        },
        querySelectorAll() {
          return [];
        },
      },
      board
    ),
    null,
    "capped mine counter should not become a global total"
  );
  assert.equal(
    core._private.readTotalMinesFromDom(
      {
        getElementById(id) {
          return hintedDigits[id] || null;
        },
        querySelectorAll() {
          return [{}];
        },
      },
      board
    ),
    null,
    "mine counter should be ignored while site hints alter the display"
  );
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
  fakeCell.classList.remove("msah-deadbeef-safe");
  assert.equal(fakeCell.getAttribute("aria-label"), "OK");
  core._private.clearHighlights(doc, "deadbeef");
  assert.equal(
    fakeCell.getAttribute("aria-label"),
    "original site label",
    "clearHighlights should restore aria-label even if site removed assistant classes first"
  );
}

{
  const doc = makeFakeDoc();
  const target = doc.createElement("div");
  const source = doc.createElement("div");
  const outside = doc.createElement("div");
  target.id = "cell_0_0";
  source.id = "cell_1_0";
  outside.id = "cell_2_0";
  doc.body.appendChild(target);
  doc.body.appendChild(source);
  doc.body.appendChild(outside);

  const board = {
    byKey: new Map([
      ["0,0", { element: target }],
      ["1,0", { element: source }],
    ]),
  };
  const explanation = {
    key: "0,0",
    conclusion: "safe",
    constraint: {
      source: "1,0",
      cells: ["0,0", "2,0"],
      count: 0,
      origin: { type: "number", source: "1,0", number: 1, knownMines: 1 },
    },
  };

  core._private.renderExplanationHighlights(doc, "deadbeef", target, explanation, board);
  assert.equal(target._classes.has("msah-deadbeef-explain-focus"), true);
  assert.equal(source._classes.has("msah-deadbeef-explain-layer-1"), true);
  assert.equal(
    outside._classes.has("msah-deadbeef-explain-layer-1"),
    false,
    "explanation highlighting should not fall back to cells outside the current board"
  );
}

console.log("compliance tests passed");
