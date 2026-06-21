// ==UserScript==
// @name         Minesweeper Online Assistant
// @namespace    https://minesweeper.online/
// @version      0.2.23
// @description  Highlights guaranteed safe cells and guaranteed mines on minesweeper.online.
// @author       Codex
// @match        https://minesweeper.online/*
// @grant        none
// @homepageURL  https://github.com/SeptYagu/minesweeper-online-assistant
// @supportURL   https://github.com/SeptYagu/minesweeper-online-assistant/issues
// @updateURL    https://raw.githubusercontent.com/SeptYagu/minesweeper-online-assistant/main/minesweeper-online-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/SeptYagu/minesweeper-online-assistant/main/minesweeper-online-helper.user.js
// ==/UserScript==

(function () {
  "use strict";

  const ASSISTANT_VERSION = "0.2.23";
  const STORAGE_KEY_SALT_LOOKUP = "__msah_salt";
  const STORAGE_KEY_LEGACY = "minesweeper-online-assistant-settings-v1";
  const SALT_LENGTH = 8;
  const CELL_ID_RE = /^cell_(\d+)_(\d+)$/;
  const TYPE_CLASS_RE = /^(?:[a-z0-9]+_)?type([0-8])$/i;
  const FLAG_CLASS_RE = /^[a-z0-9]+_flag$/i;
  const originalAriaLabels = new WeakMap();
  const assistantLabeledElements = new Set();

  function keyOf(x, y) {
    return `${x},${y}`;
  }

  function parseKey(key) {
    const [x, y] = key.split(",").map(Number);
    return { x, y };
  }

  function classNamesOf(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
    if (typeof value[Symbol.iterator] === "function") return Array.from(value);
    return [];
  }

  function generateSalt(random = Math.random) {
    const bytes = [];
    for (let i = 0; i < SALT_LENGTH; i += 2) {
      const value = Number(random());
      const safe = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      bytes.push(Math.min(255, Math.floor(safe * 256)).toString(16).padStart(2, "0"));
    }
    return bytes.join("");
  }

  function isValidSalt(value) {
    return typeof value === "string" && /^[0-9a-f]+$/.test(value) && value.length === SALT_LENGTH;
  }

  function getStorageKey(salt) {
    return `msah-${salt}-cfg`;
  }

  function getInstallSalt(store, random = Math.random) {
    if (!store) return generateSalt(random);
    try {
      const existing = store.getItem(STORAGE_KEY_SALT_LOOKUP);
      if (isValidSalt(existing)) return existing;
    } catch (_error) {
      return generateSalt(random);
    }
    const salt = generateSalt(random);
    try {
      store.setItem(STORAGE_KEY_SALT_LOOKUP, salt);
    } catch (_error) {
      // ignore
    }
    return salt;
  }

  function migrateSettings(store, salt) {
    if (!store) return null;
    const storageKey = getStorageKey(salt);
    let oldRaw = null;
    try {
      oldRaw = store.getItem(STORAGE_KEY_LEGACY);
    } catch (_error) {
      return null;
    }
    if (!oldRaw) return null;
    try {
      if (store.getItem(storageKey) !== null) {
        store.removeItem(STORAGE_KEY_LEGACY);
        return null;
      }
    } catch (_error) {
      return null;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(oldRaw);
    } catch (_error) {
      try {
        store.removeItem(STORAGE_KEY_LEGACY);
      } catch (_error2) {
        // ignore
      }
      return null;
    }
    const whitelist = {
      auto: parsed && parsed.auto !== false,
      showProbabilities: !!(parsed && parsed.showProbabilities === true),
      showExplanations: !(parsed && parsed.showExplanations === false),
      collapsed: !!(parsed && parsed.collapsed === true),
    };
    try {
      store.setItem(storageKey, JSON.stringify(whitelist));
      store.removeItem(STORAGE_KEY_LEGACY);
    } catch (_error) {
      // ignore
    }
    return whitelist;
  }

  function isRealFlagClass(className) {
    if (className === "flag") return true;
    if (className === "closed_flag" || /_closed_flag$/i.test(className)) return false;
    return FLAG_CLASS_RE.test(className);
  }

  function readCellStateFromClassNames(value) {
    const classNames = classNamesOf(value);
    let number = null;

    for (const className of classNames) {
      const match = className.match(TYPE_CLASS_RE);
      if (match) {
        number = Number(match[1]);
        break;
      }
    }

    const opened = classNames.includes("opened") || number !== null;
    const flagged = classNames.some(isRealFlagClass);

    if (flagged && !opened) return { state: "flag", number: null };
    if (opened) return { state: "open", number };
    return { state: "closed", number: null };
  }

  function normalizeBoard(board) {
    const cells = board.cells.map((cell) => ({
      ...cell,
      key: cell.key || keyOf(cell.x, cell.y),
    }));
    const width =
      board.width ?? cells.reduce((max, cell) => Math.max(max, cell.x + 1), 0);
    const height =
      board.height ?? cells.reduce((max, cell) => Math.max(max, cell.y + 1), 0);
    const byKey = new Map(cells.map((cell) => [cell.key, cell]));
    for (const cell of cells) {
      cell.neighborKeys = computeNeighborKeys(cell, width, height, byKey);
    }
    return { ...board, width, height, cells, byKey };
  }

  function computeNeighborKeys(cell, width, height, byKey) {
    const keys = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const key = keyOf(x, y);
        if (byKey.has(key)) keys.push(key);
      }
    }
    return keys;
  }

  function neighborKeys(cell, board) {
    return cell.neighborKeys || computeNeighborKeys(cell, board.width, board.height, board.byKey);
  }

  function setSignature(cells, count) {
    return `${Array.from(cells).sort().join("|")}=${count}`;
  }

  function isSubset(a, b) {
    if (a.size > b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  function difference(b, a) {
    const result = new Set();
    for (const item of b) {
      if (!a.has(item)) result.add(item);
    }
    return result;
  }

  function addAll(target, source) {
    let changed = false;
    for (const item of source) {
      if (!target.has(item)) {
        target.add(item);
        changed = true;
      }
    }
    return changed;
  }

  function compareKeys(a, b) {
    const left = parseKey(a);
    const right = parseKey(b);
    return left.y - right.y || left.x - right.x;
  }

  function sortedKeys(cells) {
    return Array.from(cells).sort(compareKeys);
  }

  function summarizeOrigin(origin) {
    if (!origin) return null;
    if (origin.type === "number") return { ...origin };
    if (origin.type === "difference") {
      return {
        type: "difference",
        subset: summarizeConstraint(origin.subset),
        superset: summarizeConstraint(origin.superset),
      };
    }
    return { ...origin };
  }

  function summarizeConstraint(constraint) {
    return {
      source: constraint.source,
      cells: sortedKeys(constraint.cells),
      count: constraint.count,
      origin: summarizeOrigin(constraint.origin),
    };
  }

  function constraintSimplicity(constraint) {
    const origin = constraint && constraint.origin;
    const depth = origin && origin.type === "difference" ? 1 : 0;
    const number = origin && origin.type === "number" ? origin.number : 99;
    return [depth, constraint.cells.size, number, constraint.count, constraint.source || ""];
  }

  function compareConstraintSimplicity(a, b) {
    const left = constraintSimplicity(a);
    const right = constraintSimplicity(b);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] < right[i]) return -1;
      if (left[i] > right[i]) return 1;
    }
    return 0;
  }

  function recordConclusions(target, cells, explanations, makeExplanation) {
    let changed = false;
    for (const key of cells) {
      if (!target.has(key)) {
        target.add(key);
        changed = true;
        if (explanations && !explanations.has(key)) {
          explanations.set(key, makeExplanation(key));
        }
      }
    }
    return changed;
  }

  function makeExplanation(key, conclusion, rule, constraint) {
    return {
      key,
      conclusion,
      rule,
      constraint: summarizeConstraint(constraint),
    };
  }

  function attachConstraintSignature(constraint) {
    constraint.signature = setSignature(constraint.cells, constraint.count);
    return constraint;
  }

  function dedupeConstraints(constraints) {
    const seen = new Set();
    const unique = [];
    for (const constraint of constraints) {
      const signature = constraint.signature || setSignature(constraint.cells, constraint.count);
      if (seen.has(signature)) continue;
      seen.add(signature);
      constraint.signature = signature;
      unique.push(constraint);
    }
    return unique;
  }

  function normalizeConstraintForKnownCells(constraint, inferredMines, inferredSafe) {
    let count = constraint.count;
    const cells = new Set();

    for (const key of constraint.cells) {
      if (inferredMines.has(key)) {
        count -= 1;
      } else if (!inferredSafe.has(key)) {
        cells.add(key);
      }
    }

    return { ...constraint, cells, count };
  }

  function buildConstraints(board, inferredMines, inferredSafe) {
    const constraints = [];
    const knownMines = new Set(inferredMines);

    for (const cell of board.cells) {
      if (cell.state !== "open" || !Number.isInteger(cell.number) || cell.number < 0) {
        continue;
      }

      let knownMineCount = 0;
      const unknown = [];

      for (const neighborKey of neighborKeys(cell, board)) {
        const neighbor = board.byKey.get(neighborKey);
        if (!neighbor) continue;
        if (knownMines.has(neighborKey)) {
          knownMineCount += 1;
        } else if (
          (neighbor.state === "closed" || neighbor.state === "flag") &&
          !inferredSafe.has(neighborKey)
        ) {
          unknown.push(neighborKey);
        }
      }

      const count = cell.number - knownMineCount;
      if (unknown.length === 0) continue;
      if (count < 0 || count > unknown.length) continue;

      constraints.push(
        attachConstraintSignature({
          source: cell.key,
          cells: new Set(unknown),
          count,
          origin: {
            type: "number",
            source: cell.key,
            number: cell.number,
            knownMines: knownMineCount,
          },
        })
      );
    }

    return dedupeConstraints(constraints.sort(compareConstraintSimplicity));
  }

  function applyConstraint(constraint, inferredMines, inferredSafe, explanations) {
    let changed = false;
    const normalized = normalizeConstraintForKnownCells(constraint, inferredMines, inferredSafe);
    const cells = normalized.cells;
    const count = normalized.count;

    if (cells.size === 0) return false;
    if (count < 0 || count > cells.size) return false;
    if (count === 0) {
      changed =
        recordConclusions(inferredSafe, cells, explanations, (key) =>
          makeExplanation(key, "safe", "all-safe", normalized)
        ) || changed;
    }
    if (count === cells.size) {
      changed =
        recordConclusions(inferredMines, cells, explanations, (key) =>
          makeExplanation(key, "mine", "all-mines", normalized)
        ) || changed;
    }
    return changed;
  }

  function solveBoard(rawBoard, options = {}) {
    const board = normalizeBoard(rawBoard);
    const inferredMines = new Set();
    const inferredSafe = new Set();
    const explanations = new Map();
    const maxIterations = options.maxIterations ?? 24;
    const maxDerived = options.maxDerived ?? 1200;
    let constraints = [];
    let changed = true;
    let iterations = 0;

    while (changed && iterations < maxIterations) {
      iterations += 1;
      changed = false;
      constraints = buildConstraints(board, inferredMines, inferredSafe);

      for (const constraint of constraints) {
        changed = applyConstraint(constraint, inferredMines, inferredSafe, explanations) || changed;
      }

      const work = constraints.slice();
      const seen = new Set(work.map((constraint) => constraint.signature || setSignature(constraint.cells, constraint.count)));

      for (let i = 0; i < work.length && work.length < maxDerived; i += 1) {
        for (let j = 0; j < work.length && work.length < maxDerived; j += 1) {
          if (i === j) continue;
          const small = work[i];
          const large = work[j];
          const smallSize = small.cells.size;
          const largeSize = large.cells.size;
          if (smallSize >= largeSize) continue;
          const count = large.count - small.count;
          if (count < 0 || count > largeSize - smallSize) continue;
          if (!isSubset(small.cells, large.cells)) continue;

          const cells = difference(large.cells, small.cells);
          if (cells.size === 0 || count < 0 || count > cells.size) continue;
          const signature = setSignature(cells, count);
          if (seen.has(signature)) continue;

          const derived = attachConstraintSignature({
            source: `${small.source}->${large.source}`,
            cells,
            count,
            origin: {
              type: "difference",
              subset: summarizeConstraint(small),
              superset: summarizeConstraint(large),
            },
          });
          changed = applyConstraint(derived, inferredMines, inferredSafe, explanations) || changed;

          seen.add(signature);
          if (count !== 0 && count !== cells.size) {
            work.push(derived);
          }
        }
      }
    }

    constraints = buildConstraints(board, inferredMines, inferredSafe);
    const probabilities = estimateProbabilities(board, constraints, inferredMines, inferredSafe);

    return {
      safe: Array.from(inferredSafe).map(parseKey),
      mines: Array.from(inferredMines).map(parseKey),
      safeKeys: inferredSafe,
      mineKeys: inferredMines,
      explanations,
      probabilities,
      constraints,
      stats: {
        width: board.width,
        height: board.height,
        open: board.cells.filter((cell) => cell.state === "open").length,
        closed: board.cells.filter((cell) => cell.state === "closed").length,
        flags: board.cells.filter((cell) => cell.state === "flag").length,
        iterations,
      },
    };
  }

  function estimateProbabilities(board, constraints, inferredMines, inferredSafe) {
    const totals = new Map();
    const counts = new Map();

    for (const constraint of constraints) {
      const candidates = Array.from(constraint.cells).filter(
        (key) => !inferredMines.has(key) && !inferredSafe.has(key)
      );
      if (candidates.length === 0) continue;
      const probability = constraint.count / candidates.length;
      for (const key of candidates) {
        totals.set(key, (totals.get(key) || 0) + probability);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }

    const probabilities = new Map();
    for (const cell of board.cells) {
      if (cell.state !== "closed" || inferredSafe.has(cell.key) || inferredMines.has(cell.key)) {
        continue;
      }
      if (counts.has(cell.key)) {
        probabilities.set(cell.key, totals.get(cell.key) / counts.get(cell.key));
      }
    }
    return probabilities;
  }

  function formatCellKey(key) {
    const point = parseKey(key);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return key;
    return `第${point.y + 1}行第${point.x + 1}列`;
  }

  function formatCellList(keys, limit = 6) {
    const sorted = sortedKeys(keys);
    if (sorted.length === 0) return "无";
    const visible = sorted.slice(0, limit).map(formatCellKey).join("、");
    return sorted.length > limit ? `${visible} 等 ${sorted.length} 格` : visible;
  }

  function relativeCellName(key, anchorKey) {
    if (!anchorKey) return formatCellKey(key);
    const cell = parseKey(key);
    const anchor = parseKey(anchorKey);
    const dx = cell.x - anchor.x;
    const dy = cell.y - anchor.y;
    if (dx === 0 && dy === 0) return "当前格";

    const vertical = dy < 0 ? "上" : dy > 0 ? "下" : "";
    const horizontal = dx < 0 ? "左" : dx > 0 ? "右" : "";
    const direction = vertical || horizontal ? `${vertical}${horizontal}` : "当前格";
    const distance =
      Math.abs(dx) <= 1 && Math.abs(dy) <= 1
        ? ""
        : `(${dx >= 0 ? "+" : ""}${dx},${dy >= 0 ? "+" : ""}${dy})`;
    return `${direction}${distance}`;
  }

  function formatRelativeCellList(keys, anchorKey, limit = 6) {
    const sorted = sortedKeys(keys);
    if (sorted.length === 0) return "无";
    const visible = sorted.slice(0, limit).map((key) => relativeCellName(key, anchorKey)).join("、");
    return sorted.length > limit ? `${visible} 等 ${sorted.length} 格` : visible;
  }

  function formatConstraintSummary(constraint) {
    if (!constraint) return "未知约束";
    const origin = constraint.origin;
    const prefix =
      origin && origin.type === "number"
        ? `数字 ${formatCellKey(origin.source)}`
        : "推导约束";
    return `${prefix}：${constraint.cells.length} 格中 ${constraint.count} 雷`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function layerName(index) {
    return ["橙色", "紫色", "蓝色", "玫红色", "绿色"][Math.min(index, 4)];
  }

  function layerClass(index) {
    return `msah-layer-text-${Math.min(index + 1, 5)}`;
  }

  function colorLabel(name, className) {
    return `<span class="msah-color-label ${className}">${escapeHtml(name)}</span>`;
  }

  function formatLayerLine(layer, index) {
    const parts = [];
    if (layer.sources.size > 0) {
      parts.push(`数字来源 ${formatCellList(layer.sources, 4)}`);
    }
    if (layer.peers.size > 0) {
      parts.push(`候选格 ${formatCellList(layer.peers, 4)}`);
    }
    return `${layerName(index)}：第 ${index + 1} 步约束，${parts.join("；") || "无可显示格"}`;
  }

  function formatLayerLineHtml(layer, index, anchorKey) {
    const parts = [];
    if (layer.sources.size > 0) parts.push(`数字 ${formatRelativeCellList(layer.sources, anchorKey, 3)}`);
    if (index === 0 && layer.peers.size > 0) {
      parts.push(`候选 ${formatRelativeCellList(layer.peers, anchorKey, 3)}`);
    }
    return `${colorLabel(layerName(index), layerClass(index))} 第${index + 1}步：${escapeHtml(parts.join("；") || "无可显示格")}`;
  }

  function formatExplanation(explanation) {
    if (!explanation) return "把鼠标移到 OK 或 M 上查看推理。";

    const conclusion = explanation.conclusion === "mine" ? "雷" : "安全";
    const constraint = explanation.constraint;
    const origin = constraint && constraint.origin;
    const related = collectExplanationKeys(explanation);
    const lines = [
      `青色：当前格 ${formatCellKey(explanation.key)}，确定${conclusion}`,
      ...related.layers.map(formatLayerLine),
    ];

    if (explanation.rule === "all-safe") {
      lines.push("结论：最靠前的颜色层剩余雷数为 0，所以当前格安全。");
    } else {
      lines.push("结论：最靠前的颜色层剩余雷数等于格子数，所以当前格是雷。");
    }

    if (origin && origin.type === "number") {
      lines.push(`橙色层来自：${formatCellKey(origin.source)} 的数字 ${origin.number}。`);
      lines.push(`橙色层约束：${constraint.cells.length} 个候选格，剩余 ${constraint.count} 雷。`);
      if (origin.knownMines > 0) {
        lines.push(`已扣除前面推出来的 ${origin.knownMines} 个雷。`);
      }
      return lines.join("\n");
    }

    if (origin && origin.type === "difference") {
      lines.push("颜色读法：橙色是相减后的差集；后面的颜色是参与相减的来源约束。");
      lines.push(`紫色来源之一：${formatConstraintSummary(origin.subset)}`);
      lines.push(`紫色来源之二：${formatConstraintSummary(origin.superset)}`);
      lines.push(`橙色差集：${formatCellList(constraint.cells)}，剩余 ${constraint.count} 雷。`);
      return lines.join("\n");
    }

    lines.push(`橙色层约束：${constraint.cells.length} 个候选格，剩余 ${constraint.count} 雷。`);
    return lines.join("\n");
  }

  function formatExplanationHtml(explanation) {
    if (!explanation) return "把鼠标移到 OK 或 M 上查看推理。";

    const conclusion = explanation.conclusion === "mine" ? "雷" : "安全";
    const constraint = explanation.constraint;
    const origin = constraint && constraint.origin;
    const related = collectExplanationKeys(explanation);
    const lines = [
      `${colorLabel("青色", "msah-layer-text-focus")} 当前：${escapeHtml(conclusion)}`,
    ];

    if (origin && origin.type === "number") {
      lines.push(
        `${colorLabel("橙色", "msah-layer-text-1")} 来源数字：${origin.number}，剩余 ${constraint.count} 雷`
      );
      return lines.join("<br>");
    }

    if (origin && origin.type === "difference") {
      const targetAssumption = explanation.conclusion === "mine" ? "不是雷" : "是雷";
      const candidates = new Set([...(related.layers[0] ? related.layers[0].peers : []), ...related.candidatePeers]);
      candidates.delete(explanation.key);
      lines.push(
        `${colorLabel("橙色", "msah-layer-text-1")} 相关候选：${escapeHtml(formatRelativeCellList(candidates, explanation.key, 4))}`
      );
      if (related.layers[1]) lines.push(formatLayerLineHtml(related.layers[1], 1, explanation.key));
      lines.push(
        `${colorLabel("紫色", "msah-layer-text-2")} 若当前格${targetAssumption}，来源数字会冲突`
      );
      return lines.join("<br>");
    }

    lines.push(formatLayerLineHtml(related.layers[0], 0, explanation.key));
    return lines.join("<br>");
  }

  function collectExplanationKeys(explanation) {
    const sources = new Set();
    const peers = new Set();
    const layers = [];
    const candidatePeers = new Set();

    function ensureLayer(depth) {
      const index = Math.max(0, depth);
      while (layers.length <= index) {
        layers.push({ sources: new Set(), peers: new Set() });
      }
      return layers[index];
    }

    function visitConstraint(constraint, depth) {
      if (!constraint) return;
      const layer = ensureLayer(depth);
      for (const key of constraint.cells || []) {
        peers.add(key);
        if (depth === 0) {
          layer.peers.add(key);
        } else {
          candidatePeers.add(key);
        }
      }
      const origin = constraint.origin;
      if (!origin) return;
      if (origin.type === "number") {
        sources.add(origin.source);
        layer.sources.add(origin.source);
      } else if (origin.type === "difference") {
        visitConstraint(origin.subset, depth + 1);
        visitConstraint(origin.superset, depth + 1);
      }
    }

    visitConstraint(explanation && explanation.constraint, 0);
    return { sources, peers, layers, candidatePeers };
  }

  function readBoardFromDom(doc = document) {
    const root =
      doc && typeof doc.getElementById === "function"
        ? doc.getElementById("AreaBlock") || doc
        : doc;
    const elements = Array.from(root.querySelectorAll("div.cell[id^='cell_']"));
    const cells = [];
    const seen = new Set();

    for (const element of elements) {
      const match = element.id.match(CELL_ID_RE);
      if (!match) continue;
      if (seen.has(element.id)) continue;
      seen.add(element.id);

      const x = Number(element.dataset.x ?? match[1]);
      const y = Number(element.dataset.y ?? match[2]);
      const state = readCellStateFromClassNames(element.classList);
      cells.push({
        x,
        y,
        key: keyOf(x, y),
        state: state.state,
        number: state.number,
        element,
      });
    }

    if (cells.length === 0) return null;
    return normalizeBoard({ cells });
  }

  function ensureStyle(doc, salt) {
    if (doc.getElementById(`msah-style-${salt}`)) return;
    const style = doc.createElement("style");
    style.id = `msah-style-${salt}`;
    style.textContent = `
      .msah-${salt}-safe {
        position: relative !important;
        box-shadow: inset 0 0 0 3px rgba(18, 164, 74, 0.95), 0 0 8px rgba(18, 164, 74, 0.45) !important;
      }
      .msah-${salt}-mine {
        position: relative !important;
        box-shadow: inset 0 0 0 3px rgba(220, 38, 38, 0.95), 0 0 8px rgba(220, 38, 38, 0.45) !important;
      }
      .msah-${salt}-prob {
        position: relative !important;
        box-shadow: inset 0 0 0 2px rgba(37, 99, 235, 0.75) !important;
      }
      .msah-${salt}-flag-ok {
        position: relative !important;
        box-shadow: inset 0 0 0 3px rgba(22, 163, 74, 0.55), 0 0 8px rgba(22, 163, 74, 0.25) !important;
      }
      .msah-${salt}-flag-q {
        position: relative !important;
        box-shadow: inset 0 0 0 3px rgba(234, 179, 8, 0.72), 0 0 8px rgba(234, 179, 8, 0.32) !important;
      }
      .msah-${salt}-explain-focus,
      .msah-${salt}-explain-layer-1,
      .msah-${salt}-explain-layer-2,
      .msah-${salt}-explain-layer-3,
      .msah-${salt}-explain-layer-4,
      .msah-${salt}-explain-layer-5 {
        position: relative !important;
      }
      .msah-${salt}-explain-focus::before,
      .msah-${salt}-explain-layer-1::before,
      .msah-${salt}-explain-layer-2::before,
      .msah-${salt}-explain-layer-3::before,
      .msah-${salt}-explain-layer-4::before,
      .msah-${salt}-explain-layer-5::before {
        content: "";
        position: absolute;
        inset: 2px;
        border-radius: 2px;
        pointer-events: none;
        z-index: 3;
      }
      .msah-${salt}-explain-focus {
        box-shadow:
          inset 0 0 0 4px rgba(6, 182, 212, 1),
          0 0 0 2px rgba(255, 255, 255, 0.95),
          0 0 12px rgba(6, 182, 212, 0.92) !important;
      }
      .msah-${salt}-explain-focus::before {
        background: rgba(6, 182, 212, 0.46);
      }
      .msah-${salt}-explain-layer-1 {
        box-shadow:
          inset 0 0 0 4px rgba(234, 88, 12, 1),
          0 0 0 2px rgba(254, 215, 170, 0.95),
          0 0 12px rgba(234, 88, 12, 0.9) !important;
      }
      .msah-${salt}-explain-layer-1::before {
        background: rgba(234, 88, 12, 0.44);
      }
      .msah-${salt}-explain-layer-2 {
        box-shadow:
          inset 0 0 0 4px rgba(147, 51, 234, 1),
          0 0 0 2px rgba(233, 213, 255, 0.95),
          0 0 12px rgba(147, 51, 234, 0.9) !important;
      }
      .msah-${salt}-explain-layer-2::before {
        background: rgba(147, 51, 234, 0.42);
      }
      .msah-${salt}-explain-layer-3 {
        box-shadow:
          inset 0 0 0 4px rgba(37, 99, 235, 1),
          0 0 0 2px rgba(191, 219, 254, 0.95),
          0 0 12px rgba(37, 99, 235, 0.9) !important;
      }
      .msah-${salt}-explain-layer-3::before {
        background: rgba(37, 99, 235, 0.42);
      }
      .msah-${salt}-explain-layer-4 {
        box-shadow:
          inset 0 0 0 4px rgba(219, 39, 119, 1),
          0 0 0 2px rgba(251, 207, 232, 0.95),
          0 0 12px rgba(219, 39, 119, 0.9) !important;
      }
      .msah-${salt}-explain-layer-4::before {
        background: rgba(219, 39, 119, 0.42);
      }
      .msah-${salt}-explain-layer-5 {
        box-shadow:
          inset 0 0 0 4px rgba(22, 163, 74, 1),
          0 0 0 2px rgba(187, 247, 208, 0.95),
          0 0 12px rgba(22, 163, 74, 0.9) !important;
      }
      .msah-${salt}-explain-layer-5::before {
        background: rgba(22, 163, 74, 0.42);
      }
      .msah-${salt}-safe::after,
      .msah-${salt}-mine::after,
      .msah-${salt}-prob::after,
      .msah-${salt}-flag-q::after {
        content: attr(aria-label);
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        min-width: 16px;
        padding: 1px 3px;
        border-radius: 3px;
        color: #fff;
        font: 700 10px/1.2 Arial, sans-serif;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
        pointer-events: none;
        z-index: 4;
      }
      .msah-${salt}-safe::after { background: rgba(18, 164, 74, 0.92); }
      .msah-${salt}-mine::after { background: rgba(220, 38, 38, 0.92); }
      .msah-${salt}-prob::after { background: rgba(37, 99, 235, 0.88); }
      .msah-${salt}-flag-q::after {
        background: rgba(234, 179, 8, 0.68);
        color: #422006;
        text-shadow: none;
      }
      #msah-panel-${salt} {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2147483647;
        width: 238px;
        padding: 10px;
        border: 1px solid rgba(15, 23, 42, 0.25);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.95);
        color: #111827;
        box-shadow: 0 14px 35px rgba(15, 23, 42, 0.22);
        font: 13px/1.4 Arial, "Microsoft YaHei", sans-serif;
      }
      #msah-panel-${salt} * { box-sizing: border-box; }
      #msah-panel-${salt}.msah-collapsed { width: auto; padding: 6px 8px; }
      #msah-panel-${salt}.msah-collapsed .msah-body { display: none; }
      .msah-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
        font-weight: 700;
      }
      .msah-title { white-space: nowrap; }
      .msah-icon-button {
        width: 24px;
        height: 24px;
        border: 1px solid rgba(15, 23, 42, 0.25);
        border-radius: 5px;
        background: #f8fafc;
        color: #111827;
        cursor: pointer;
        font-weight: 700;
        line-height: 1;
      }
      .msah-status {
        min-height: 34px;
        margin-bottom: 8px;
        padding: 6px;
        border-radius: 6px;
        background: #f1f5f9;
        color: #334155;
      }
      .msah-buttons {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
        margin-bottom: 8px;
      }
      .msah-buttons button {
        min-height: 30px;
        border: 1px solid rgba(15, 23, 42, 0.25);
        border-radius: 5px;
        background: #fff;
        color: #111827;
        cursor: pointer;
        font-weight: 700;
      }
      .msah-buttons button:hover,
      .msah-icon-button:hover { background: #e2e8f0; }
      .msah-options {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
      }
      .msah-options label {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        white-space: nowrap;
      }
      .msah-options input { margin: 0; }
      .msah-explain {
        min-height: 76px;
        margin-top: 8px;
        padding: 6px;
        border: 1px solid rgba(14, 165, 233, 0.28);
        border-radius: 6px;
        background: #f0f9ff;
        color: #0f172a;
        font-size: 12px;
      }
      .msah-explain-title {
        margin-bottom: 4px;
        color: #0369a1;
        font-weight: 700;
      }
      .msah-explain-text {
        white-space: pre-line;
        word-break: break-word;
      }
      .msah-color-label {
        display: inline-block;
        min-width: 34px;
        margin-right: 4px;
        padding: 1px 4px;
        border-radius: 3px;
        color: #fff;
        font-weight: 700;
        text-align: center;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.32);
      }
      .msah-layer-text-focus { background: #0891b2; }
      .msah-layer-text-1 { background: #ea580c; }
      .msah-layer-text-2 { background: #9333ea; }
      .msah-layer-text-3 { background: #2563eb; }
      .msah-layer-text-4 { background: #db2777; }
      .msah-layer-text-5 { background: #16a34a; }
      .msah-note {
        margin-top: 8px;
        padding: 6px;
        border: 1px solid rgba(15, 23, 42, 0.15);
        border-radius: 6px;
        background: #f8fafc;
        color: #475569;
        font-size: 12px;
      }
      @media (max-width: 640px) {
        #msah-panel-${salt} {
          left: 10px;
          right: 10px;
          bottom: 10px;
          width: auto;
        }
      }
    `;
    doc.head.appendChild(style);
  }

  function loadSettings(salt, store) {
    const defaults = {
      auto: true,
      showProbabilities: false,
      showExplanations: true,
      collapsed: false,
    };
    if (!store) return defaults;
    try {
      const raw = store.getItem(getStorageKey(salt));
      if (!raw) return defaults;
      const settings = JSON.parse(raw);
      return {
        auto: settings.auto !== false,
        showProbabilities: settings.showProbabilities === true,
        showExplanations: settings.showExplanations !== false,
        collapsed: settings.collapsed === true,
      };
    } catch (_error) {
      return defaults;
    }
  }

  function saveSettings(salt, settings, store) {
    if (!store) return;
    try {
      store.setItem(
        getStorageKey(salt),
        JSON.stringify({
          auto: settings.auto,
          showProbabilities: settings.showProbabilities,
          showExplanations: settings.showExplanations,
          collapsed: settings.collapsed,
        })
      );
    } catch (_error) {
      // ignore
    }
  }

  function createPanel(settings, salt, doc) {
    const panelId = `msah-panel-${salt}`;
    const existing = doc.getElementById(panelId);
    if (existing) return existing;

    const panel = doc.createElement("div");
    panel.id = panelId;
    if (settings.collapsed) panel.classList.add("msah-collapsed");
    panel.innerHTML = `
      <div class="msah-header">
        <div class="msah-title">扫雷辅助 <span style="font-weight:400;color:#64748b">v${ASSISTANT_VERSION}</span></div>
        <button class="msah-icon-button" type="button" data-msah-action="toggle" title="收起/展开">-</button>
      </div>
      <div class="msah-body">
        <div class="msah-status" data-msah-status>等待棋盘...</div>
        <div class="msah-buttons">
          <button type="button" data-msah-action="analyze" title="重新分析当前棋盘">分析</button>
          <button type="button" data-msah-action="clear" title="移除所有高亮">清除</button>
        </div>
        <div class="msah-options">
          <label title="棋盘变化后自动重新分析"><input type="checkbox" data-msah-option="auto"> 自动</label>
          <label title="对未确定格显示粗略局部概率"><input type="checkbox" data-msah-option="probabilities"> 概率</label>
          <label title="显示悬停推理说明和解释高亮"><input type="checkbox" data-msah-option="explanations"> 说明</label>
        </div>
        <div class="msah-explain" data-msah-explain>
          <div class="msah-explain-title">推理说明</div>
          <div class="msah-explain-text" data-msah-explain-text>把鼠标移到 OK 或 M 上查看推理。</div>
        </div>
        <div class="msah-note" data-msah-note>提示：按 ~ 显示/隐藏分析。本脚本只做高亮分析，不发送任何鼠标事件，也不会操作网页棋盘状态。</div>
      </div>
    `;
    doc.body.appendChild(panel);
    panel.querySelector("[data-msah-option='auto']").checked = settings.auto;
    panel.querySelector("[data-msah-option='probabilities']").checked = settings.showProbabilities;
    panel.querySelector("[data-msah-option='explanations']").checked = settings.showExplanations;
    panel.querySelector("[data-msah-explain]").hidden = !settings.showExplanations;
    return panel;
  }

  function getHighlightClassNames(salt) {
    return {
      safe: `msah-${salt}-safe`,
      mine: `msah-${salt}-mine`,
      prob: `msah-${salt}-prob`,
      flagOk: `msah-${salt}-flag-ok`,
      flagQ: `msah-${salt}-flag-q`,
      explainFocus: `msah-${salt}-explain-focus`,
      explainLayers: [
        `msah-${salt}-explain-layer-1`,
        `msah-${salt}-explain-layer-2`,
        `msah-${salt}-explain-layer-3`,
        `msah-${salt}-explain-layer-4`,
        `msah-${salt}-explain-layer-5`,
      ],
    };
  }

  function getAllHighlightClasses(salt) {
    const names = getHighlightClassNames(salt);
    return [
      names.safe,
      names.mine,
      names.prob,
      names.flagOk,
      names.flagQ,
      names.explainFocus,
      ...names.explainLayers,
    ];
  }

  function classTokensWithoutAssistantClasses(value, salt) {
    return classNamesOf(value)
      .filter((className) => !className.startsWith(`msah-${salt}-`))
      .sort()
      .join(" ");
  }

  function classValueOfElement(element) {
    if (!element) return "";
    if (typeof element.className === "string") return element.className;
    if (element.classList) return element.classList;
    return "";
  }

  function isAssistantOnlyClassMutation(mutation, salt) {
    if (!mutation || mutation.type !== "attributes" || mutation.attributeName !== "class") {
      return false;
    }
    const before = classTokensWithoutAssistantClasses(mutation.oldValue || "", salt);
    const after = classTokensWithoutAssistantClasses(classValueOfElement(mutation.target), salt);
    return before === after;
  }

  function isEditableElement(element) {
    if (!element) return false;
    const tag = (element.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = String(
        element.type || (typeof element.getAttribute === "function" && element.getAttribute("type")) || "text"
      ).toLowerCase();
      return [
        "text",
        "search",
        "url",
        "tel",
        "email",
        "password",
        "number",
        "date",
        "datetime-local",
        "month",
        "time",
        "week",
      ].includes(type);
    }
    if (element.isContentEditable) return true;
    return typeof element.closest === "function" && !!element.closest("[contenteditable='true']");
  }

  function isAnalysisShortcut(event) {
    if (!event || event.defaultPrevented) return false;
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    if (isEditableElement(event.target)) return false;
    const key = event.key || "";
    return (
      event.code === "Backquote" ||
      key === "`" ||
      key === "~" ||
      key === "～" ||
      key === "·" ||
      event.keyCode === 192 ||
      event.which === 192
    );
  }

  function shouldAutoAnalyze(settings, analysisVisible) {
    return !!(settings && settings.auto && analysisVisible);
  }

  function clearHighlights(doc, salt) {
    const names = getHighlightClassNames(salt);
    const all = getAllHighlightClasses(salt);
    const labelClasses = [names.safe, names.mine, names.prob, names.flagQ];
    const selector = all.map((c) => `.${c}`).join(", ");
    const handled = new Set();
    for (const element of doc.querySelectorAll(selector)) {
      handled.add(element);
      clearHighlightElement(element, all, labelClasses);
    }
    for (const element of Array.from(assistantLabeledElements)) {
      if (!handled.has(element)) restoreOriginalAriaLabel(element);
    }
  }

  function clearHighlightElement(element, allClasses, labelClasses) {
    const hasAssistantLabel =
      labelClasses.some((cls) => element.classList.contains(cls)) || originalAriaLabels.has(element);
    for (const cls of allClasses) element.classList.remove(cls);
    if (hasAssistantLabel) restoreOriginalAriaLabel(element);
    element.removeAttribute("data-msah-explain-label");
  }

  function clearHighlightsFromBoard(board, salt) {
    if (!board || !board.cells) return;
    const names = getHighlightClassNames(salt);
    const all = getAllHighlightClasses(salt);
    const labelClasses = [names.safe, names.mine, names.prob, names.flagQ];
    for (const cell of board.cells) {
      if (cell.element) clearHighlightElement(cell.element, all, labelClasses);
    }
  }

  function clearExplanationHighlights(doc, salt) {
    const names = getHighlightClassNames(salt);
    const all = [names.explainFocus, ...names.explainLayers];
    const selector = all.map((c) => `.${c}`).join(", ");
    for (const element of doc.querySelectorAll(selector)) {
      for (const cls of all) element.classList.remove(cls);
      element.removeAttribute("data-msah-explain-label");
    }
  }

  function getHighlightForCell(cell, result, settings, salt) {
    const names = getHighlightClassNames(salt);
    if (cell.state === "flag") {
      return result.mineKeys.has(cell.key)
        ? { className: names.flagOk, label: null }
        : { className: names.flagQ, label: "?" };
    }

    if (result.safeKeys.has(cell.key)) return { className: names.safe, label: "OK" };
    if (result.mineKeys.has(cell.key)) return { className: names.mine, label: "M" };

    if (settings.showProbabilities && result.probabilities.has(cell.key)) {
      const probability = result.probabilities.get(cell.key);
      const percent = Math.min(99, Math.max(0, Math.round(probability * 100)));
      return { className: names.prob, label: `${percent}%` };
    }

    return null;
  }

  function setAssistantAriaLabel(element, label) {
    if (!originalAriaLabels.has(element)) {
      originalAriaLabels.set(element, element.getAttribute("aria-label"));
    }
    assistantLabeledElements.add(element);
    element.setAttribute("aria-label", label);
  }

  function restoreOriginalAriaLabel(element) {
    if (!originalAriaLabels.has(element)) {
      assistantLabeledElements.delete(element);
      element.removeAttribute("aria-label");
      return;
    }
    const original = originalAriaLabels.get(element);
    originalAriaLabels.delete(element);
    assistantLabeledElements.delete(element);
    if (original === null) {
      element.removeAttribute("aria-label");
    } else {
      element.setAttribute("aria-label", original);
    }
  }

  function renderHighlights(board, result, settings, doc, salt) {
    clearHighlightsFromBoard(board, salt);

    for (const cell of board.cells) {
      if (!cell.element) continue;
      const highlight = getHighlightForCell(cell, result, settings, salt);
      if (!highlight) continue;
      cell.element.classList.add(highlight.className);
      if (highlight.label) setAssistantAriaLabel(cell.element, highlight.label);
    }
  }

  function updateStatus(panel, board, result, note = "") {
    const status = panel.querySelector("[data-msah-status]");
    if (!board) {
      status.textContent = "没有检测到棋盘。进入一局游戏后会自动分析。";
      return;
    }

    status.textContent =
      `棋盘 ${result.stats.width}x${result.stats.height} | ` +
      `安全 ${result.safe.length} | 确定雷 ${result.mines.length} | ` +
      `未开 ${result.stats.closed} | 旗 ${result.stats.flags}` +
      (note ? ` | ${note}` : "");
  }

  function updateExplanation(panel, explanation) {
    const target = panel.querySelector("[data-msah-explain-text]");
    if (!target) return;
    target.innerHTML = formatExplanationHtml(explanation);
  }

  function updateExplanationModule(panel, settings, doc, salt) {
    const block = panel.querySelector("[data-msah-explain]");
    if (block) block.hidden = !settings.showExplanations;
    if (!settings.showExplanations) {
      clearExplanationHighlights(doc, salt);
      updateExplanation(panel, null);
    }
  }

  function cellElementKey(element) {
    if (!element || !element.id) return null;
    const match = element.id.match(CELL_ID_RE);
    return match ? keyOf(Number(match[1]), Number(match[2])) : null;
  }

  function getCellElementByKey(doc, key, board) {
    if (board) {
      const cell = board.byKey && board.byKey.get(key);
      return cell && cell.element ? cell.element : null;
    }
    const point = parseKey(key);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return doc.getElementById(`cell_${point.x}_${point.y}`);
  }

  function renderExplanationHighlights(doc, salt, targetElement, explanation, board) {
    clearExplanationHighlights(doc, salt);
    if (!targetElement || !explanation) return;

    const names = getHighlightClassNames(salt);
    const related = collectExplanationKeys(explanation);
    const painted = new Set();
    targetElement.classList.add(names.explainFocus);

    const candidateClass = names.explainLayers[0];
    for (const key of related.candidatePeers || []) {
      if (key === explanation.key) continue;
      const element = getCellElementByKey(doc, key, board);
      if (element && element !== targetElement) {
        element.classList.add(candidateClass);
        painted.add(key);
      }
    }

    related.layers.forEach((layer, index) => {
      const className = names.explainLayers[Math.min(index, names.explainLayers.length - 1)];
      for (const key of layer.peers) {
        if (painted.has(key)) continue;
        const element = getCellElementByKey(doc, key, board);
        if (element && element !== targetElement) {
          element.classList.add(className);
          painted.add(key);
        }
      }
      for (const key of layer.sources) {
        if (painted.has(key)) continue;
        const element = getCellElementByKey(doc, key, board);
        if (element && element !== targetElement) {
          element.classList.add(className);
          painted.add(key);
        }
      }
    });
  }

  function bootstrap(doc, opts) {
    const store = (opts && opts.store) || (typeof localStorage !== "undefined" ? localStorage : null);
    const random = (opts && opts.random) || Math.random;
    const salt = getInstallSalt(store, random);
    migrateSettings(store, salt);

    ensureStyle(doc, salt);
    const settings = loadSettings(salt, store);
    const panel = createPanel(settings, salt, doc);
    updateExplanationModule(panel, settings, doc, salt);
    let latestBoard = null;
    let latestResult = null;
    let observer = null;
    let scheduled = false;
    let analysisVisible = true;

    function detachObserver() {
      if (observer) observer.disconnect();
    }

    function attachObserver() {
      detachObserver();
      if (!shouldAutoAnalyze(settings, analysisVisible)) return;
      observer = new MutationObserver((mutations) => {
        if (mutations.length > 0 && mutations.every((mutation) => isAssistantOnlyClassMutation(mutation, salt))) {
          return;
        }
        scheduleAnalyze();
      });
      const target = doc.getElementById("AreaBlock") || doc.body;
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
        attributeOldValue: true,
      });
    }

    function analyze(options = {}) {
      const { attach = true, note = "" } = options;
      analysisVisible = true;
      detachObserver();
      latestBoard = readBoardFromDom(doc);
      if (!latestBoard) {
        latestResult = null;
        clearHighlights(doc, salt);
        updateExplanation(panel, null);
        updateStatus(panel, null, null);
        if (attach) attachObserver();
        return;
      }
      latestResult = solveBoard(latestBoard);
      renderHighlights(latestBoard, latestResult, settings, doc, salt);
      updateExplanation(panel, null);
      updateStatus(panel, latestBoard, latestResult, note);
      if (attach) attachObserver();
    }

    function scheduleAnalyze() {
      if (!shouldAutoAnalyze(settings, analysisVisible)) return;
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(() => {
        scheduled = false;
        if (!analysisVisible) return;
        analyze();
      }, 120);
    }

    function clearAnalysis() {
      analysisVisible = false;
      scheduled = false;
      detachObserver();
      clearHighlights(doc, salt);
      latestBoard = null;
      latestResult = null;
      updateExplanation(panel, null);
      const status = panel.querySelector("[data-msah-status]");
      if (status) status.textContent = "分析已隐藏。按 ~ 或点击“分析”恢复。";
    }

    function toggleAnalysis() {
      if (latestResult) {
        clearAnalysis();
      } else {
        analyze({ note: "快捷键" });
      }
    }

    panel.addEventListener("click", (event) => {
      const target = event.target.closest("[data-msah-action]");
      if (!target) return;
      const action = target.dataset.msahAction;

      if (action === "toggle") {
        settings.collapsed = !settings.collapsed;
        panel.classList.toggle("msah-collapsed", settings.collapsed);
        target.textContent = settings.collapsed ? "+" : "-";
        saveSettings(salt, settings, store);
        return;
      }

      if (action === "analyze") {
        analyze();
      }
      if (action === "clear") {
        clearAnalysis();
      }
    });

    panel.addEventListener("change", (event) => {
      const target = event.target.closest("[data-msah-option]");
      if (!target) return;
      if (target.dataset.msahOption === "auto") {
        settings.auto = target.checked;
        saveSettings(salt, settings, store);
        attachObserver();
      }
      if (target.dataset.msahOption === "probabilities") {
        settings.showProbabilities = target.checked;
        saveSettings(salt, settings, store);
        analyze();
      }
      if (target.dataset.msahOption === "explanations") {
        settings.showExplanations = target.checked;
        saveSettings(salt, settings, store);
        updateExplanationModule(panel, settings, doc, salt);
      }
    });

    doc.addEventListener("mouseover", (event) => {
      if (!settings.showExplanations) return;
      if (!latestBoard || !latestResult || !event.target || typeof event.target.closest !== "function") return;
      const cellElement = event.target.closest("div.cell[id^='cell_']");
      const key = cellElementKey(cellElement);
      if (!key) return;
      const boardCell = latestBoard.byKey && latestBoard.byKey.get(key);
      if (!boardCell || boardCell.element !== cellElement) return;
      const explanation = latestResult.explanations && latestResult.explanations.get(key);
      if (!explanation) return;
      updateExplanation(panel, explanation);
      renderExplanationHighlights(doc, salt, cellElement, explanation, latestBoard);
    });

    doc.addEventListener("keydown", (event) => {
      if (!isAnalysisShortcut(event)) return;
      event.preventDefault();
      toggleAnalysis();
    });

    panel.querySelector("[data-msah-action='toggle']").textContent = settings.collapsed ? "+" : "-";
    analyze();
    attachObserver();

    return { salt, settings };
  }

  const core = {
    keyOf,
    parseKey,
    readCellStateFromClassNames,
    solveBoard,
    bootstrap,
    _private: {
      buildConstraints,
      collectExplanationKeys,
      clearHighlights,
      clearExplanationHighlights,
      classTokensWithoutAssistantClasses,
      createPanel,
      estimateProbabilities,
      formatExplanation,
      formatExplanationHtml,
      getAllHighlightClasses,
      getHighlightClassNames,
      getHighlightForCell,
      getInstallSalt,
      getStorageKey,
      isAssistantOnlyClassMutation,
      isAnalysisShortcut,
      isEditableElement,
      loadSettings,
      migrateSettings,
      normalizeBoard,
      readBoardFromDom,
      relativeCellName,
      renderHighlights,
      renderExplanationHighlights,
      saveSettings,
      shouldAutoAnalyze,
      updateExplanationModule,
    },
  };

  if (typeof window !== "undefined") {
    window.MinesweeperAssistantCore = core;
  }

  if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => bootstrap(document), { once: true });
  } else if (typeof document !== "undefined") {
    bootstrap(document);
  }
})();
