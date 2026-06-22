// ==UserScript==
// @name         Minesweeper Online Assistant
// @namespace    https://minesweeper.online/
// @version      0.2.31
// @description  Highlights guaranteed safe cells and guaranteed mines on minesweeper.online.
// @author       Codex
// @match        https://minesweeper.online/*
// @grant        none
// @homepageURL  https://github.com/SeptYagu/minesweeper-online-assistant
// @supportURL   https://github.com/SeptYagu/minesweeper-online-assistant/issues
// @updateURL    https://raw.githubusercontent.com/SeptYagu/minesweeper-online-assistant/main/minesweeper-online-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/SeptYagu/minesweeper-online-assistant/main/minesweeper-online-helper.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const ASSISTANT_VERSION = "0.2.31";
  const STORAGE_KEY_SALT_LOOKUP = "__msah_salt";
  const STORAGE_KEY_LEGACY = "minesweeper-online-assistant-settings-v1";
  const RESCUE_STATE_KEY = "__MSAH_RESCUE_STATE";
  const RESCUE_LIMIT = 3;
  const RESCUE_MINE_VALUE = 10;
  const RESCUE_BOOM_VALUE = 11;
  const RESCUE_OPENED_VALUE = 12;
  const RESCUE_CLOSED_VALUE = 13;
  const GAME_LEFT_CLICK = 0;
  const SALT_LENGTH = 8;
  const DEFAULT_MAX_EXACT_CELLS = 18;
  const DEFAULT_MAX_EXACT_MODELS = 50000;
  const DEFAULT_MAX_EXACT_NODES = 250000;
  const DEFAULT_MAX_GLOBAL_OUTSIDE_CELLS = 512;
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

  function getRescueStorageKey(salt, gameKey) {
    return `msah-${salt}-rescue-${gameKey}`;
  }

  function normalizeRescueGameId(value) {
    if (value === null || value === undefined) return null;
    const text = String(value);
    return text ? text : null;
  }

  function getCurrentPageGameId(globalObj) {
    const path =
      globalObj &&
      globalObj.location &&
      typeof globalObj.location.pathname === "string"
        ? globalObj.location.pathname
        : "";
    const match = path.match(/\/game\/(\d+)/);
    return match ? match[1] : null;
  }

  function createRescueState() {
    return {
      boards: {},
      currentGameId: null,
      installed: false,
    };
  }

  function getRescueState(globalObj) {
    if (!globalObj) return null;
    if (globalObj[RESCUE_STATE_KEY]) return globalObj[RESCUE_STATE_KEY];
    const state = createRescueState();
    try {
      Object.defineProperty(globalObj, RESCUE_STATE_KEY, {
        value: state,
        configurable: true,
      });
    } catch (_error) {
      globalObj[RESCUE_STATE_KEY] = state;
    }
    return state;
  }

  function readIndexedNumericArray(value, length) {
    if (!value || !Number.isInteger(length) || length < 0) return null;
    const out = [];
    for (let i = 0; i < length; i += 1) {
      const raw = value[i];
      const number = Number(raw);
      out.push(Number.isFinite(number) ? number : 0);
    }
    return out;
  }

  function isRescueGameMeta(value) {
    return (
      value &&
      Number.isInteger(Number(value.sizeX)) &&
      Number.isInteger(Number(value.sizeY)) &&
      Number.isInteger(Number(value.mines)) &&
      normalizeRescueGameId(value.id)
    );
  }

  function isRescueBoardPayload(value, length) {
    return (
      value &&
      value.t &&
      value.o &&
      value.f &&
      value.t.length !== 0 &&
      readIndexedNumericArray(value.t, length) !== null
    );
  }

  function countRescueMines(types) {
    return types.filter((value) => value === RESCUE_MINE_VALUE).length;
  }

  function captureRescueGameInit(state, args) {
    if (!state || !Array.isArray(args) || !isRescueGameMeta(args[0])) return null;
    const meta = args[0];
    const width = Number(meta.sizeX);
    const height = Number(meta.sizeY);
    const mines = Number(meta.mines);
    const length = width * height;
    const payload = args[1];
    if (!isRescueBoardPayload(payload, length)) return null;

    const types = readIndexedNumericArray(payload.t, length);
    const opened = readIndexedNumericArray(payload.o, length);
    const flags = readIndexedNumericArray(payload.f, length);
    if (!types || !opened || !flags) return null;

    const mineCount = countRescueMines(types);
    const gameId = normalizeRescueGameId(meta.id);
    const source = {
      gameId,
      width,
      height,
      mines,
      types,
      opened,
      flags,
      hasOpened: opened.some(Boolean),
      trusted: true,
      available: mineCount === mines,
      reason: mineCount === mines ? "" : "雷图尚未明文可用",
      updatedAt: Date.now(),
    };
    state.boards[gameId] = source;
    state.currentGameId = gameId;
    return source;
  }

  function applyRescueTouchCells(source, touchCells) {
    if (!source || !Array.isArray(touchCells)) return false;
    let changed = false;
    for (let i = 0; i + 4 < touchCells.length; i += 5) {
      const x = Number(touchCells[i]);
      const y = Number(touchCells[i + 1]);
      let type = Number(touchCells[i + 2]);
      let opened = Number(touchCells[i + 3]);
      const flagged = Number(touchCells[i + 4]);
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      if (x < 0 || y < 0 || x >= source.width || y >= source.height) continue;
      if (type === RESCUE_BOOM_VALUE) continue;
      if (type === RESCUE_OPENED_VALUE) {
        type = opened;
        opened = 1;
      } else if (type === RESCUE_CLOSED_VALUE) {
        type = 0;
      }
      const index = x * source.height + y;
      source.types[index] = Number.isFinite(type) ? type : source.types[index];
      source.opened[index] = Number.isFinite(opened) ? opened : source.opened[index];
      source.flags[index] = Number.isFinite(flagged) ? flagged : source.flags[index];
      changed = true;
    }
    if (changed) {
      source.hasOpened = source.opened.some(Boolean);
      source.updatedAt = Date.now();
    }
    return changed;
  }

  function captureRescueTouchUpdate(state, args) {
    if (!state || !Array.isArray(args)) return false;
    const gameId = normalizeRescueGameId(args[1]);
    const action = args[2];
    const source = gameId ? state.boards[gameId] : null;
    if (!source || !action || !Array.isArray(action.touchCells)) return false;
    return applyRescueTouchCells(source, action.touchCells);
  }

  function captureRescueClickRequest(state, requestPayload) {
    if (!state || !Array.isArray(requestPayload)) return false;
    const actionName = requestPayload[0];
    const args = requestPayload[1];
    if (actionName !== "GameplayController.gameClickWsAction" || !Array.isArray(args)) return false;
    const gameId = normalizeRescueGameId(args[1]);
    const source = gameId ? state.boards[gameId] : null;
    if (!source) return false;
    const type = Number(args[2]);
    const x = Number(args[3]);
    const y = Number(args[4]);
    if (type !== GAME_LEFT_CLICK || source.hasOpened) return false;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= source.width || y >= source.height) {
      return false;
    }
    if (source.types[x * source.height + y] === RESCUE_MINE_VALUE) {
      source.trusted = false;
      source.available = false;
      source.reason = "首开触发过雷位重排";
      source.updatedAt = Date.now();
      return true;
    }
    return false;
  }

  function captureRescueSocketResponse(state, payload) {
    if (!state || !Array.isArray(payload)) return;
    const args = payload[2];
    captureRescueGameInit(state, args);
    captureRescueTouchUpdate(state, args);
  }

  function installRescueSocketCapture(globalObj) {
    const state = getRescueState(globalObj);
    if (!globalObj || !state || state.installed) return state;
    state.installed = true;

    function patchEmitter(emitter) {
      if (!emitter || typeof emitter.emit !== "function" || emitter.__msahRescueEmitPatched) return;
      const originalEmit = emitter.emit;
      try {
        Object.defineProperty(emitter, "__msahRescueEmitPatched", { value: true });
      } catch (_error) {
        emitter.__msahRescueEmitPatched = true;
      }
      emitter.emit = function patchedEmit(eventName, payload, ...rest) {
        if (eventName === "request") captureRescueClickRequest(state, payload);
        return originalEmit.call(this, eventName, payload, ...rest);
      };
    }

    function patchSocket(socket) {
      if (!socket || socket.__msahRescueSocketPatched) return socket;
      try {
        Object.defineProperty(socket, "__msahRescueSocketPatched", { value: true });
      } catch (_error) {
        socket.__msahRescueSocketPatched = true;
      }
      patchEmitter(socket);
      if (socket.volatile) patchEmitter(socket.volatile);
      if (typeof socket.on === "function") {
        const originalOn = socket.on;
        socket.on = function patchedOn(eventName, handler, ...rest) {
          if (eventName === "response" && typeof handler === "function") {
            const wrapped = function wrappedResponse(payload, ...args) {
              captureRescueSocketResponse(state, payload);
              return handler.call(this, payload, ...args);
            };
            return originalOn.call(this, eventName, wrapped, ...rest);
          }
          return originalOn.call(this, eventName, handler, ...rest);
        };
      }
      return socket;
    }

    function patchIo(io) {
      if (!io || io.__msahRescueIoPatched) return io;
      try {
        Object.defineProperty(io, "__msahRescueIoPatched", { value: true });
      } catch (_error) {
        io.__msahRescueIoPatched = true;
      }
      if (typeof io.connect === "function") {
        const originalConnect = io.connect;
        io.connect = function patchedConnect(...args) {
          return patchSocket(originalConnect.apply(this, args));
        };
      }
      return io;
    }

    try {
      const descriptor = Object.getOwnPropertyDescriptor(globalObj, "io");
      let current = descriptor && "value" in descriptor ? descriptor.value : globalObj.io;
      if (current) current = patchIo(current);
      if (!descriptor || descriptor.configurable) {
        Object.defineProperty(globalObj, "io", {
          configurable: true,
          enumerable: descriptor ? descriptor.enumerable : true,
          get() {
            return current;
          },
          set(value) {
            current = patchIo(value);
          },
        });
      }
    } catch (_error) {
      if (globalObj.io) patchIo(globalObj.io);
    }

    return state;
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

  function loadRescueUsage(salt, gameKey, store) {
    const defaults = { used: 0, keys: [] };
    if (!store || !gameKey) return defaults;
    try {
      const raw = store.getItem(getRescueStorageKey(salt, gameKey));
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      const keys = Array.isArray(parsed.keys)
        ? parsed.keys.filter((key) => typeof key === "string")
        : [];
      const used = Math.min(
        RESCUE_LIMIT,
        Math.max(Number(parsed.used) || 0, Math.min(RESCUE_LIMIT, keys.length))
      );
      return { used, keys: keys.slice(0, RESCUE_LIMIT) };
    } catch (_error) {
      return defaults;
    }
  }

  function saveRescueUsage(salt, gameKey, usage, store) {
    if (!store || !gameKey || !usage) return;
    try {
      store.setItem(
        getRescueStorageKey(salt, gameKey),
        JSON.stringify({
          used: Math.min(RESCUE_LIMIT, Math.max(0, Number(usage.used) || 0)),
          keys: Array.isArray(usage.keys) ? usage.keys.slice(0, RESCUE_LIMIT) : [],
        })
      );
    } catch (_error) {
      // ignore
    }
  }

  function getRescueRemaining(usage) {
    return Math.max(0, RESCUE_LIMIT - Math.min(RESCUE_LIMIT, usage && usage.used ? usage.used : 0));
  }

  function recordRescueUse(salt, gameKey, key, store) {
    const usage = loadRescueUsage(salt, gameKey, store);
    if (!key) return { ok: false, counted: false, usage };
    if (usage.keys.includes(key)) return { ok: true, counted: false, usage };
    if (usage.used >= RESCUE_LIMIT) return { ok: false, counted: false, usage };
    usage.keys.push(key);
    usage.used = Math.min(RESCUE_LIMIT, usage.used + 1);
    saveRescueUsage(salt, gameKey, usage, store);
    return { ok: true, counted: true, usage };
  }

  function hasActionableDeterministicMove(result, board = null) {
    if (!result || !result.safeKeys || !result.mineKeys) return false;
    if (!board || !Array.isArray(board.cells)) {
      return result.safeKeys.size > 0 || result.mineKeys.size > 0;
    }
    return board.cells.some(
      (cell) =>
        cell &&
        cell.state === "closed" &&
        (result.safeKeys.has(cell.key) || result.mineKeys.has(cell.key))
    );
  }

  function isDeadGuessCandidate(result, board = null) {
    return !!result && !hasActionableDeterministicMove(result, board);
  }

  function findMatchingRescueSource(globalObj, board) {
    const state = globalObj && globalObj[RESCUE_STATE_KEY];
    if (!state || !state.boards || !board) return null;
    const preferred = getCurrentPageGameId(globalObj) || state.currentGameId;
    const candidates = [];
    if (preferred && state.boards[preferred]) candidates.push(state.boards[preferred]);
    for (const source of Object.values(state.boards)) {
      if (!candidates.includes(source)) candidates.push(source);
    }
    return (
      candidates.find(
        (source) =>
          source &&
          source.width === board.width &&
          source.height === board.height &&
          source.trusted &&
          source.available
      ) || null
    );
  }

  function getCurrentRescueGameKey(globalObj, board) {
    const source = findMatchingRescueSource(globalObj, board);
    return (
      (source && source.gameId) ||
      getCurrentPageGameId(globalObj) ||
      (board ? `${board.width}x${board.height}:${board.totalMines ?? "unknown"}` : null)
    );
  }

  function getRescueAnswerFromSource(source, key) {
    if (!source || !source.trusted || !source.available || !key) return null;
    const point = parseKey(key);
    if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) return null;
    if (point.x < 0 || point.y < 0 || point.x >= source.width || point.y >= source.height) return null;
    const value = source.types[point.x * source.height + point.y];
    if (value === RESCUE_MINE_VALUE) return { key, isMine: true };
    if (Number.isInteger(value) && value >= 0 && value <= 8) return { key, isMine: false };
    return null;
  }

  function getClosedBoardCell(board, key) {
    const cell = board && board.byKey ? board.byKey.get(key) : null;
    return cell && cell.state === "closed" ? cell : null;
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

  function intersection(a, b) {
    const result = new Set();
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const item of small) {
      if (large.has(item)) result.add(item);
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
    if (origin.type === "overlap-difference") {
      return {
        type: "overlap-difference",
        left: summarizeConstraint(origin.left),
        right: summarizeConstraint(origin.right),
        leftOnly: sortedKeys(origin.leftOnly || []),
        rightOnly: sortedKeys(origin.rightOnly || []),
        shared: sortedKeys(origin.shared || []),
        delta: origin.delta,
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

  function makeOverlapDifferenceConstraint(left, right, cells, count) {
    return attachConstraintSignature({
      source: `${left.source}<->${right.source}`,
      cells,
      count,
      origin: {
        type: "overlap-difference",
        left: summarizeConstraint(left),
        right: summarizeConstraint(right),
        leftOnly: sortedKeys(difference(left.cells, right.cells)),
        rightOnly: sortedKeys(difference(right.cells, left.cells)),
        shared: sortedKeys(intersection(left.cells, right.cells)),
        delta: right.count - left.count,
      },
    });
  }

  function deriveOverlapDifferenceConstraints(left, right, inferredMines, inferredSafe) {
    const normalizedLeft = normalizeConstraintForKnownCells(left, inferredMines, inferredSafe);
    const normalizedRight = normalizeConstraintForKnownCells(right, inferredMines, inferredSafe);

    if (
      normalizedLeft.cells.size === 0 ||
      normalizedRight.cells.size === 0 ||
      normalizedLeft.count < 0 ||
      normalizedRight.count < 0 ||
      normalizedLeft.count > normalizedLeft.cells.size ||
      normalizedRight.count > normalizedRight.cells.size
    ) {
      return [];
    }

    const leftOnly = difference(normalizedLeft.cells, normalizedRight.cells);
    const rightOnly = difference(normalizedRight.cells, normalizedLeft.cells);
    if (leftOnly.size === 0 && rightOnly.size === 0) return [];

    const delta = normalizedRight.count - normalizedLeft.count;
    const derived = [];
    if (delta === rightOnly.size) {
      if (leftOnly.size > 0) {
        derived.push(makeOverlapDifferenceConstraint(normalizedLeft, normalizedRight, leftOnly, 0));
      }
      if (rightOnly.size > 0) {
        derived.push(
          makeOverlapDifferenceConstraint(normalizedLeft, normalizedRight, rightOnly, rightOnly.size)
        );
      }
    } else if (delta === -leftOnly.size) {
      if (leftOnly.size > 0) {
        derived.push(
          makeOverlapDifferenceConstraint(normalizedLeft, normalizedRight, leftOnly, leftOnly.size)
        );
      }
      if (rightOnly.size > 0) {
        derived.push(makeOverlapDifferenceConstraint(normalizedLeft, normalizedRight, rightOnly, 0));
      }
    }

    return derived;
  }

  function buildConstraintComponents(constraints) {
    const variableToConstraints = new Map();
    constraints.forEach((constraint, index) => {
      for (const key of constraint.cells) {
        if (!variableToConstraints.has(key)) variableToConstraints.set(key, []);
        variableToConstraints.get(key).push(index);
      }
    });

    const visitedConstraints = new Set();
    const visitedVariables = new Set();
    const components = [];

    for (let start = 0; start < constraints.length; start += 1) {
      if (visitedConstraints.has(start)) continue;
      const queue = [{ type: "constraint", value: start }];
      const componentConstraintIndexes = [];
      const componentVariables = new Set();

      while (queue.length > 0) {
        const item = queue.shift();
        if (item.type === "constraint") {
          if (visitedConstraints.has(item.value)) continue;
          visitedConstraints.add(item.value);
          componentConstraintIndexes.push(item.value);
          for (const key of constraints[item.value].cells) {
            if (!visitedVariables.has(key)) queue.push({ type: "variable", value: key });
          }
        } else {
          if (visitedVariables.has(item.value)) continue;
          visitedVariables.add(item.value);
          componentVariables.add(item.value);
          for (const constraintIndex of variableToConstraints.get(item.value) || []) {
            if (!visitedConstraints.has(constraintIndex)) {
              queue.push({ type: "constraint", value: constraintIndex });
            }
          }
        }
      }

      if (componentVariables.size > 0) {
        components.push({
          constraints: componentConstraintIndexes.map((index) => constraints[index]),
          variables: sortedKeys(componentVariables),
        });
      }
    }

    return components;
  }

  function orderVariablesForExactSearch(variables, constraints) {
    const degree = new Map(variables.map((key) => [key, 0]));
    for (const constraint of constraints) {
      for (const key of constraint.cells) {
        degree.set(key, (degree.get(key) || 0) + 1);
      }
    }
    return variables
      .slice()
      .sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || compareKeys(a, b));
  }

  function enumerateExactComponent(component, limits) {
    const variableKeys = orderVariablesForExactSearch(component.variables, component.constraints);
    const variableIndex = new Map(variableKeys.map((key, index) => [key, index]));
    const exactConstraints = component.constraints.map((constraint) => ({
      source: constraint.source,
      count: constraint.count,
      indexes: Array.from(constraint.cells)
        .map((key) => variableIndex.get(key))
        .filter((index) => Number.isInteger(index)),
    }));
    const variableConstraints = Array.from({ length: variableKeys.length }, () => []);
    exactConstraints.forEach((constraint, constraintIndex) => {
      for (const variable of constraint.indexes) {
        variableConstraints[variable].push(constraintIndex);
      }
    });

    const mineCounts = exactConstraints.map(() => 0);
    const remainingCounts = exactConstraints.map((constraint) => constraint.indexes.length);
    const assignment = Array.from({ length: variableKeys.length }, () => 0);
    const mineTotals = Array.from({ length: variableKeys.length }, () => 0);
    const modelsByMineCount = new Map();
    const mineTotalsByMineCount = new Map();
    let modelCount = 0;
    let nodeCount = 0;
    let complete = true;

    function recordModel() {
      if (modelCount >= limits.maxModels) {
        complete = false;
        return;
      }
      modelCount += 1;
      let minesInModel = 0;
      for (const value of assignment) minesInModel += value;
      modelsByMineCount.set(minesInModel, (modelsByMineCount.get(minesInModel) || 0) + 1);
      if (!mineTotalsByMineCount.has(minesInModel)) {
        mineTotalsByMineCount.set(minesInModel, Array.from({ length: assignment.length }, () => 0));
      }
      const bucketTotals = mineTotalsByMineCount.get(minesInModel);
      for (let index = 0; index < assignment.length; index += 1) {
        if (assignment[index] === 1) {
          mineTotals[index] += 1;
          bucketTotals[index] += 1;
        }
      }
    }

    function search(position) {
      if (!complete) return;
      nodeCount += 1;
      if (nodeCount > limits.maxNodes) {
        complete = false;
        return;
      }

      if (position === variableKeys.length) {
        for (let index = 0; index < exactConstraints.length; index += 1) {
          if (mineCounts[index] !== exactConstraints[index].count) return;
        }
        recordModel();
        return;
      }

      for (const value of [0, 1]) {
        assignment[position] = value;
        let valid = true;
        for (const constraintIndex of variableConstraints[position]) {
          remainingCounts[constraintIndex] -= 1;
          mineCounts[constraintIndex] += value;
          const constraint = exactConstraints[constraintIndex];
          if (
            mineCounts[constraintIndex] > constraint.count ||
            mineCounts[constraintIndex] + remainingCounts[constraintIndex] < constraint.count
          ) {
            valid = false;
          }
        }

        if (valid) search(position + 1);

        for (const constraintIndex of variableConstraints[position]) {
          remainingCounts[constraintIndex] += 1;
          mineCounts[constraintIndex] -= value;
        }
        if (!complete) return;
      }
    }

    for (const constraint of exactConstraints) {
      if (constraint.count < 0 || constraint.count > constraint.indexes.length) {
        return {
          complete: true,
          modelCount: 0,
          variableKeys,
          modelsByMineCount,
          mineTotalsByMineCount,
          mineKeys: new Set(),
          safeKeys: new Set(),
          probabilities: new Map(),
        };
      }
    }

    search(0);
    const mineKeys = new Set();
    const safeKeys = new Set();
    const probabilities = new Map();
    if (!complete || modelCount === 0) {
      return {
        complete,
        modelCount,
        nodeCount,
        variableKeys,
        modelsByMineCount,
        mineTotalsByMineCount,
        mineKeys,
        safeKeys,
        probabilities,
      };
    }

    for (let index = 0; index < variableKeys.length; index += 1) {
      const key = variableKeys[index];
      if (mineTotals[index] === 0) {
        safeKeys.add(key);
      } else if (mineTotals[index] === modelCount) {
        mineKeys.add(key);
      } else {
        probabilities.set(key, mineTotals[index] / modelCount);
      }
    }

    return {
      complete,
      modelCount,
      nodeCount,
      variableKeys,
      modelsByMineCount,
      mineTotalsByMineCount,
      mineKeys,
      safeKeys,
      probabilities,
    };
  }

  function makeExactExplanation(key, conclusion, component, modelCount) {
    const sources = new Set();
    for (const constraint of component.constraints) {
      if (constraint.source) sources.add(constraint.source);
    }
    return {
      key,
      conclusion,
      rule: "exact",
      constraint: {
        source: "exact",
        cells: sortedKeys(component.variables),
        count: null,
        origin: {
          type: "exact",
          modelCount,
          sources: sortedKeys(sources),
        },
      },
    };
  }

  function solveExactComponents(constraints, inferredMines, inferredSafe, options = {}) {
    const limits = {
      maxCells: options.maxExactCells ?? DEFAULT_MAX_EXACT_CELLS,
      maxModels: options.maxExactModels ?? DEFAULT_MAX_EXACT_MODELS,
      maxNodes: options.maxExactNodes ?? DEFAULT_MAX_EXACT_NODES,
    };
    const mineKeys = new Set();
    const safeKeys = new Set();
    const probabilities = new Map();
    const explanations = new Map();
    const components = [];
    const stats = {
      components: 0,
      solvedComponents: 0,
      skippedComponents: 0,
      models: 0,
      nodes: 0,
    };

    for (const component of buildConstraintComponents(constraints)) {
      stats.components += 1;
      if (component.variables.length > limits.maxCells) {
        stats.skippedComponents += 1;
        continue;
      }

      const result = enumerateExactComponent(component, limits);
      stats.models += result.modelCount || 0;
      stats.nodes += result.nodeCount || 0;
      if (!result.complete || result.modelCount === 0) {
        stats.skippedComponents += 1;
        continue;
      }

      stats.solvedComponents += 1;
      components.push({
        component,
        variableKeys: result.variableKeys,
        modelCount: result.modelCount,
        modelsByMineCount: result.modelsByMineCount,
        mineTotalsByMineCount: result.mineTotalsByMineCount,
      });
      for (const key of result.mineKeys) {
        if (!inferredMines.has(key) && !inferredSafe.has(key)) {
          mineKeys.add(key);
          explanations.set(key, makeExactExplanation(key, "mine", component, result.modelCount));
        }
      }
      for (const key of result.safeKeys) {
        if (!inferredMines.has(key) && !inferredSafe.has(key)) {
          safeKeys.add(key);
          explanations.set(key, makeExactExplanation(key, "safe", component, result.modelCount));
        }
      }
      for (const [key, probability] of result.probabilities) {
        if (!inferredMines.has(key) && !inferredSafe.has(key)) {
          probabilities.set(key, probability);
        }
      }
    }

    return { mineKeys, safeKeys, probabilities, explanations, components, stats };
  }

  function addWeightedCount(target, key, value) {
    if (!Number.isFinite(value) || value <= 0) return false;
    target.set(key, (target.get(key) || 0) + value);
    return Number.isFinite(target.get(key));
  }

  function combineDistributions(left, right, maxTotal) {
    const result = new Map();
    for (const [leftCount, leftWays] of left) {
      for (const [rightCount, rightWays] of right) {
        const count = leftCount + rightCount;
        if (count > maxTotal) continue;
        if (!addWeightedCount(result, count, leftWays * rightWays)) return null;
      }
    }
    return result;
  }

  function combinationDistribution(count, maxTotal) {
    const result = new Map();
    if (count < 0 || count > DEFAULT_MAX_GLOBAL_OUTSIDE_CELLS) return null;
    let value = 1;
    for (let mines = 0; mines <= count && mines <= maxTotal; mines += 1) {
      result.set(mines, value);
      if (mines < count) {
        value = (value * (count - mines)) / (mines + 1);
        if (!Number.isFinite(value)) return null;
      }
    }
    return result;
  }

  function combinationValue(count, choose) {
    if (choose < 0 || choose > count) return 0;
    let value = 1;
    for (let index = 0; index < choose; index += 1) {
      value = (value * (count - index)) / (index + 1);
      if (!Number.isFinite(value)) return Infinity;
    }
    return value;
  }

  function isAllModels(value, total) {
    return Math.abs(value - total) <= Math.max(1, total) * 1e-12;
  }

  function makeGlobalExplanation(key, conclusion, totalMines, modelCount, cells, sources) {
    return {
      key,
      conclusion,
      rule: "global",
      constraint: {
        source: "global",
        cells: sortedKeys(cells),
        count: totalMines,
        origin: {
          type: "global",
          totalMines,
          modelCount,
          sources: sortedKeys(sources || []),
        },
      },
    };
  }

  function solveGlobalMines(board, exact, knownMines, knownSafe, options = {}) {
    const totalMines = Number.isInteger(board.totalMines) ? board.totalMines : null;
    const stats = {
      enabled: false,
      totalMines,
      totalModels: 0,
      outsideCells: 0,
      reason: null,
    };
    if (totalMines === null) {
      stats.reason = "no-total";
      return { mineKeys: new Set(), safeKeys: new Set(), probabilities: new Map(), explanations: new Map(), stats };
    }
    if (exact.stats.skippedComponents > 0) {
      stats.reason = "skipped-components";
      return { mineKeys: new Set(), safeKeys: new Set(), probabilities: new Map(), explanations: new Map(), stats };
    }

    const maxOutsideCells = options.maxGlobalOutsideCells ?? DEFAULT_MAX_GLOBAL_OUTSIDE_CELLS;
    const componentVariables = new Set();
    for (const component of exact.components) {
      for (const key of component.variableKeys) componentVariables.add(key);
    }

    const outsideKeys = [];
    for (const cell of board.cells) {
      if (cell.state !== "closed" && cell.state !== "flag") continue;
      if (knownMines.has(cell.key) || knownSafe.has(cell.key) || componentVariables.has(cell.key)) continue;
      outsideKeys.push(cell.key);
    }
    stats.outsideCells = outsideKeys.length;
    if (outsideKeys.length > maxOutsideCells) {
      stats.reason = "outside-limit";
      return { mineKeys: new Set(), safeKeys: new Set(), probabilities: new Map(), explanations: new Map(), stats };
    }

    const remainingMines = totalMines - knownMines.size;
    const componentCapacity = exact.components.reduce((sum, component) => sum + component.variableKeys.length, 0);
    if (remainingMines < 0 || remainingMines > componentCapacity + outsideKeys.length) {
      stats.reason = "invalid-total";
      return { mineKeys: new Set(), safeKeys: new Set(), probabilities: new Map(), explanations: new Map(), stats };
    }

    const componentDistributions = exact.components.map((component) => component.modelsByMineCount);
    const outsideDistribution = combinationDistribution(outsideKeys.length, remainingMines);
    if (!outsideDistribution) {
      stats.reason = "outside-combinations";
      return { mineKeys: new Set(), safeKeys: new Set(), probabilities: new Map(), explanations: new Map(), stats };
    }

    const distributions = [...componentDistributions, outsideDistribution];
    const prefix = [new Map([[0, 1]])];
    for (let index = 0; index < distributions.length; index += 1) {
      const next = combineDistributions(prefix[index], distributions[index], remainingMines);
      if (!next) {
        stats.reason = "overflow";
        return { mineKeys: new Set(), safeKeys: new Set(), probabilities: new Map(), explanations: new Map(), stats };
      }
      prefix.push(next);
    }

    const suffix = Array.from({ length: distributions.length + 1 }, () => new Map());
    suffix[distributions.length].set(0, 1);
    for (let index = distributions.length - 1; index >= 0; index -= 1) {
      const next = combineDistributions(distributions[index], suffix[index + 1], remainingMines);
      if (!next) {
        stats.reason = "overflow";
        return { mineKeys: new Set(), safeKeys: new Set(), probabilities: new Map(), explanations: new Map(), stats };
      }
      suffix[index] = next;
    }

    const totalModels = prefix[distributions.length].get(remainingMines) || 0;
    if (!Number.isFinite(totalModels) || totalModels <= 0) {
      stats.reason = "no-global-models";
      return { mineKeys: new Set(), safeKeys: new Set(), probabilities: new Map(), explanations: new Map(), stats };
    }

    const mineKeys = new Set();
    const safeKeys = new Set();
    const probabilities = new Map();
    const explanations = new Map();

    exact.components.forEach((component, componentIndex) => {
      const sources = new Set();
      for (const constraint of component.component.constraints) {
        if (constraint.source) sources.add(constraint.source);
      }
      component.variableKeys.forEach((key, variableIndex) => {
        let mineWays = 0;
        for (const [componentMineCount, bucketTotals] of component.mineTotalsByMineCount) {
          const cellMineModels = bucketTotals[variableIndex] || 0;
          if (cellMineModels === 0) continue;
          for (const [leftCount, leftWays] of prefix[componentIndex]) {
            const rightNeed = remainingMines - leftCount - componentMineCount;
            const rightWays = suffix[componentIndex + 1].get(rightNeed) || 0;
            if (rightWays > 0) mineWays += leftWays * cellMineModels * rightWays;
          }
        }
        if (!Number.isFinite(mineWays)) return;
        if (mineWays === 0) {
          safeKeys.add(key);
          explanations.set(
            key,
            makeGlobalExplanation(key, "safe", totalMines, totalModels, component.variableKeys, sources)
          );
        } else if (isAllModels(mineWays, totalModels)) {
          mineKeys.add(key);
          explanations.set(
            key,
            makeGlobalExplanation(key, "mine", totalMines, totalModels, component.variableKeys, sources)
          );
        } else {
          probabilities.set(key, mineWays / totalModels);
        }
      });
    });

    if (outsideKeys.length > 0) {
      for (const key of outsideKeys) {
        let mineWays = 0;
        for (const [componentMineCount, componentWays] of prefix[exact.components.length]) {
          const outsideMines = remainingMines - componentMineCount;
          mineWays += componentWays * combinationValue(outsideKeys.length - 1, outsideMines - 1);
        }
        if (!Number.isFinite(mineWays)) continue;
        if (mineWays === 0) {
          safeKeys.add(key);
          explanations.set(key, makeGlobalExplanation(key, "safe", totalMines, totalModels, outsideKeys, []));
        } else if (isAllModels(mineWays, totalModels)) {
          mineKeys.add(key);
          explanations.set(key, makeGlobalExplanation(key, "mine", totalMines, totalModels, outsideKeys, []));
        }
      }
    }

    stats.enabled = true;
    stats.reason = "ok";
    stats.totalModels = totalModels;
    return { mineKeys, safeKeys, probabilities, explanations, stats };
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

      for (let i = 0; i < work.length && work.length < maxDerived; i += 1) {
        for (let j = i + 1; j < work.length && work.length < maxDerived; j += 1) {
          for (const derived of deriveOverlapDifferenceConstraints(
            work[i],
            work[j],
            inferredMines,
            inferredSafe
          )) {
            if (seen.has(derived.signature)) continue;
            changed = applyConstraint(derived, inferredMines, inferredSafe, explanations) || changed;
            seen.add(derived.signature);
          }
        }
      }
    }

    constraints = buildConstraints(board, inferredMines, inferredSafe);
    const knownMinesBeforeExact = new Set(inferredMines);
    const knownSafeBeforeExact = new Set(inferredSafe);
    const exact = solveExactComponents(constraints, inferredMines, inferredSafe, options);
    const global = solveGlobalMines(board, exact, knownMinesBeforeExact, knownSafeBeforeExact, options);
    for (const key of exact.mineKeys) {
      if (!inferredMines.has(key)) {
        inferredMines.add(key);
        if (!explanations.has(key) && exact.explanations.has(key)) {
          explanations.set(key, exact.explanations.get(key));
        }
      }
    }
    for (const key of exact.safeKeys) {
      if (!inferredSafe.has(key)) {
        inferredSafe.add(key);
        if (!explanations.has(key) && exact.explanations.has(key)) {
          explanations.set(key, exact.explanations.get(key));
        }
      }
    }
    for (const key of global.mineKeys) {
      if (!inferredMines.has(key) && !inferredSafe.has(key)) {
        inferredMines.add(key);
        if (!explanations.has(key) && global.explanations.has(key)) {
          explanations.set(key, global.explanations.get(key));
        }
      }
    }
    for (const key of global.safeKeys) {
      if (!inferredSafe.has(key) && !inferredMines.has(key)) {
        inferredSafe.add(key);
        if (!explanations.has(key) && global.explanations.has(key)) {
          explanations.set(key, global.explanations.get(key));
        }
      }
    }

    constraints = buildConstraints(board, inferredMines, inferredSafe);
    const probabilities = estimateProbabilities(board, constraints, inferredMines, inferredSafe);
    for (const [key, probability] of exact.probabilities) {
      const cell = board.byKey.get(key);
      if (cell && cell.state === "closed" && !inferredMines.has(key) && !inferredSafe.has(key)) {
        probabilities.set(key, probability);
      }
    }
    for (const [key, probability] of global.probabilities) {
      const cell = board.byKey.get(key);
      if (cell && cell.state === "closed" && !inferredMines.has(key) && !inferredSafe.has(key)) {
        probabilities.set(key, probability);
      }
    }

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
        totalMines: board.totalMines ?? null,
        iterations,
        exact: exact.stats,
        global: global.stats,
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

    if (origin && origin.type === "overlap-difference") {
      lines.push("重叠读法：两个约束共享一部分候选格，先把重叠部分抵消。");
      lines.push(`紫色来源之一：${formatConstraintSummary(origin.left)}`);
      lines.push(`紫色来源之二：${formatConstraintSummary(origin.right)}`);
      lines.push(`共享候选：${formatCellList(origin.shared)}。`);
      lines.push(`左侧差集：${formatCellList(origin.leftOnly)}。`);
      lines.push(`右侧差集：${formatCellList(origin.rightOnly)}。`);
      return lines.join("\n");
    }

    if (origin && origin.type === "exact") {
      lines.push("枚举读法：检查这个局部区域的所有合法雷布局。");
      lines.push(`橙色层范围：${formatCellList(constraint.cells)}。`);
      lines.push(
        `合法布局：${origin.modelCount} 种；当前格在全部布局中${
          explanation.conclusion === "mine" ? "都是雷" : "都不是雷"
        }。`
      );
      if (origin.sources && origin.sources.length > 0) {
        lines.push(`数字来源：${formatCellList(origin.sources)}。`);
      }
      return lines.join("\n");
    }

    if (origin && origin.type === "global") {
      lines.push("全局读法：把总雷数和所有局部合法布局一起计算。");
      lines.push(`全局总雷数：${origin.totalMines}。`);
      lines.push(
        `合法全局布局：${origin.modelCount} 种；当前格在全部布局中${
          explanation.conclusion === "mine" ? "都是雷" : "都不是雷"
        }。`
      );
      if (origin.sources && origin.sources.length > 0) {
        lines.push(`相关数字来源：${formatCellList(origin.sources)}。`);
      }
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

    if (origin && origin.type === "overlap-difference") {
      lines.push(
        `${colorLabel("橙色", "msah-layer-text-1")} 重叠相减：共享候选先抵消`
      );
      if (related.layers[1]) lines.push(formatLayerLineHtml(related.layers[1], 1, explanation.key));
      lines.push(
        `${colorLabel("紫色", "msah-layer-text-2")} 两侧差集雷数差达到边界`
      );
      return lines.join("<br>");
    }

    if (origin && origin.type === "exact") {
      lines.push(
        `${colorLabel("橙色", "msah-layer-text-1")} 精确枚举：${origin.modelCount} 种合法布局`
      );
      lines.push(
        `${colorLabel("紫色", "msah-layer-text-2")} 当前格在全部布局中${
          explanation.conclusion === "mine" ? "都是雷" : "都不是雷"
        }`
      );
      if (related.layers[0]) lines.push(formatLayerLineHtml(related.layers[0], 0, explanation.key));
      return lines.join("<br>");
    }

    if (origin && origin.type === "global") {
      lines.push(
        `${colorLabel("橙色", "msah-layer-text-1")} 全局雷数：${origin.totalMines} 雷`
      );
      lines.push(
        `${colorLabel("紫色", "msah-layer-text-2")} ${origin.modelCount} 种全局布局中当前格${
          explanation.conclusion === "mine" ? "都是雷" : "都不是雷"
        }`
      );
      if (related.layers[0]) lines.push(formatLayerLineHtml(related.layers[0], 0, explanation.key));
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
      } else if (origin.type === "overlap-difference") {
        visitConstraint(origin.left, depth + 1);
        visitConstraint(origin.right, depth + 1);
      } else if (origin.type === "exact") {
        for (const source of origin.sources || []) {
          sources.add(source);
          layer.sources.add(source);
        }
      } else if (origin.type === "global") {
        for (const source of origin.sources || []) {
          sources.add(source);
          layer.sources.add(source);
        }
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

  function readTopAreaDigit(element) {
    if (!element) return null;
    for (const className of classNamesOf(element.className || element.classList)) {
      const match = className.match(/^(?:[a-z0-9]+_)?top-area-num(-|[0-9])$/i);
      if (match) return match[1] === "-" ? "-" : Number(match[1]);
    }
    return null;
  }

  function readRemainingMinesFromDom(doc = document) {
    if (!doc || typeof doc.getElementById !== "function") return null;
    const hundreds = readTopAreaDigit(doc.getElementById("top_area_mines_100"));
    const tens = readTopAreaDigit(doc.getElementById("top_area_mines_10"));
    const ones = readTopAreaDigit(doc.getElementById("top_area_mines_1"));
    if (hundreds === null || tens === null || ones === null) return null;
    if (hundreds === "-") return -(Number(tens || 0) * 10 + Number(ones || 0));
    if (tens === "-") return -Number(ones || 0);
    if (ones === "-") return null;
    return Number(hundreds) * 100 + Number(tens) * 10 + Number(ones);
  }

  function hasActiveMineCountHint(doc = document) {
    if (!doc || typeof doc.querySelectorAll !== "function") return false;
    try {
      return doc.querySelectorAll(".hint-flag, .hint-flag-mc").length > 0;
    } catch (_error) {
      return false;
    }
  }

  function readTotalMinesFromDom(doc = document, board = null) {
    if (!board || !board.cells || hasActiveMineCountHint(doc)) return null;
    const remaining = readRemainingMinesFromDom(doc);
    if (!Number.isInteger(remaining) || remaining < 0 || remaining >= 999) return null;
    const flags = board.cells.filter((cell) => cell.state === "flag").length;
    const hidden = board.cells.filter((cell) => cell.state === "closed" || cell.state === "flag").length;
    const total = remaining + flags;
    if (!Number.isInteger(total) || total < 0 || total > hidden) return null;
    return total;
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
      .msah-${salt}-rescue-safe {
        position: relative !important;
        box-shadow: inset 0 0 0 4px rgba(20, 184, 166, 0.98), 0 0 10px rgba(20, 184, 166, 0.6) !important;
      }
      .msah-${salt}-rescue-mine {
        position: relative !important;
        box-shadow: inset 0 0 0 4px rgba(124, 58, 237, 0.98), 0 0 10px rgba(124, 58, 237, 0.58) !important;
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
      .msah-${salt}-flag-q::after,
      .msah-${salt}-rescue-safe::after,
      .msah-${salt}-rescue-mine::after {
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
      .msah-${salt}-rescue-safe::after { background: rgba(15, 118, 110, 0.94); }
      .msah-${salt}-rescue-mine::after { background: rgba(109, 40, 217, 0.94); }
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
        grid-template-columns: repeat(3, minmax(0, 1fr));
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
      .msah-buttons button:disabled {
        cursor: not-allowed;
        opacity: 0.52;
      }
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
          <button type="button" data-msah-action="rescue" title="仅在无确定结论时检查当前悬停格">救援 3/3</button>
        </div>
        <div class="msah-options">
          <label title="棋盘变化后自动重新分析"><input type="checkbox" data-msah-option="auto"> 自动</label>
          <label title="显示局部雷率，精确枚举优先"><input type="checkbox" data-msah-option="probabilities"> 概率</label>
          <label title="显示悬停推理说明和解释高亮"><input type="checkbox" data-msah-option="explanations"> 说明</label>
        </div>
        <div class="msah-explain" data-msah-explain>
          <div class="msah-explain-title">推理说明</div>
          <div class="msah-explain-text" data-msah-explain-text>把鼠标移到 OK 或 M 上查看推理。</div>
        </div>
        <div class="msah-note" data-msah-note>提示：按 ~ 显示/隐藏分析。本脚本不发送任何鼠标事件，也不会操作网页棋盘状态。</div>
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
      rescueSafe: `msah-${salt}-rescue-safe`,
      rescueMine: `msah-${salt}-rescue-mine`,
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
      names.rescueSafe,
      names.rescueMine,
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

  function nodeContainsBoard(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === "AreaBlock") return true;
    if (typeof node.matches === "function" && node.matches("div.cell[id^='cell_']")) return true;
    return (
      typeof node.querySelector === "function" &&
      !!(node.querySelector("#AreaBlock") || node.querySelector("div.cell[id^='cell_']"))
    );
  }

  function isBoardStructureMutation(mutation) {
    if (!mutation || mutation.type !== "childList") return false;
    if (nodeContainsBoard(mutation.target)) return true;
    const changed = [...Array.from(mutation.addedNodes || []), ...Array.from(mutation.removedNodes || [])];
    return changed.some(nodeContainsBoard);
  }

  function isRelevantAutoAnalyzeMutation(mutation, salt) {
    if (isAssistantOnlyClassMutation(mutation, salt)) return false;
    if (mutation && mutation.type === "attributes") return true;
    return isBoardStructureMutation(mutation);
  }

  function getAutoAnalyzeObserverTargets(doc = document) {
    const targets = [];
    const body = doc && doc.body ? doc.body : null;
    const area = doc && typeof doc.getElementById === "function" ? doc.getElementById("AreaBlock") : null;

    if (body) {
      targets.push({
        target: body,
        options: { childList: true, subtree: true },
      });
    }

    if (area && area !== body) {
      targets.push({
        target: area,
        options: {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class"],
          attributeOldValue: true,
        },
      });
    } else if (!body && area) {
      targets.push({
        target: area,
        options: {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class"],
          attributeOldValue: true,
        },
      });
    }

    if (targets.length === 0 && doc) {
      targets.push({
        target: doc,
        options: { childList: true, subtree: true },
      });
    }

    return targets;
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
    const labelClasses = [names.safe, names.mine, names.prob, names.flagQ, names.rescueSafe, names.rescueMine];
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
    const labelClasses = [names.safe, names.mine, names.prob, names.flagQ, names.rescueSafe, names.rescueMine];
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

  function getHighlightForCell(cell, result, settings, salt, rescueHint = null) {
    const names = getHighlightClassNames(salt);
    if (cell.state === "flag") {
      return result.mineKeys.has(cell.key)
        ? { className: names.flagOk, label: null }
        : { className: names.flagQ, label: "?" };
    }

    if (result.safeKeys.has(cell.key)) return { className: names.safe, label: "OK" };
    if (result.mineKeys.has(cell.key)) return { className: names.mine, label: "M" };
    if (rescueHint && rescueHint.key === cell.key) {
      return rescueHint.isMine
        ? { className: names.rescueMine, label: "避" }
        : { className: names.rescueSafe, label: "开" };
    }

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

  function renderHighlights(board, result, settings, doc, salt, rescueHint = null) {
    clearHighlightsFromBoard(board, salt);

    for (const cell of board.cells) {
      if (!cell.element) continue;
      const highlight = getHighlightForCell(cell, result, settings, salt, rescueHint);
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
      (Number.isInteger(result.stats.totalMines) ? `总雷 ${result.stats.totalMines} | ` : "") +
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
    const globalObj = (opts && opts.globalObj) || (typeof window !== "undefined" ? window : null);
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
    let rescueTargetKey = null;
    let rescueHint = null;
    let latestRescueGameKey = null;

    function detachObserver() {
      if (observer) observer.disconnect();
    }

    function getRescueSource() {
      return findMatchingRescueSource(globalObj, latestBoard);
    }

    function getRescueGameKey() {
      return getCurrentRescueGameKey(globalObj, latestBoard);
    }

    function pruneRescueHint() {
      if (!rescueHint || !getClosedBoardCell(latestBoard, rescueHint.key)) {
        rescueHint = null;
      }
    }

    function updateRescueButton() {
      const button = panel.querySelector("[data-msah-action='rescue']");
      if (!button) return;
      const gameKey = getRescueGameKey();
      const usage = loadRescueUsage(salt, gameKey, store);
      const remaining = getRescueRemaining(usage);
      const source = getRescueSource();
      const targetCell = getClosedBoardCell(latestBoard, rescueTargetKey);
      button.textContent = `救援 ${remaining}/${RESCUE_LIMIT}`;

      let reason = "";
      if (!latestBoard || !latestResult) reason = "未检测到棋盘";
      else if (!isDeadGuessCandidate(latestResult, latestBoard)) reason = "当前还有确定结论";
      else if (!source) reason = "当前局没有可用答案源";
      else if (!targetCell) reason = "先把鼠标移到一个未开格";
      else if (remaining <= 0) reason = "本局救援次数已用完";

      button.disabled = !!reason;
      button.title = reason || "只检查当前悬停的一个未开格";
    }

    function attachObserver() {
      detachObserver();
      if (!shouldAutoAnalyze(settings, analysisVisible)) return;
      observer = new MutationObserver((mutations) => {
        if (!mutations.some((mutation) => isRelevantAutoAnalyzeMutation(mutation, salt))) {
          return;
        }
        scheduleAnalyze();
      });
      for (const entry of getAutoAnalyzeObserverTargets(doc)) {
        observer.observe(entry.target, entry.options);
      }
    }

    function analyze(options = {}) {
      const { attach = true, note = "" } = options;
      analysisVisible = true;
      detachObserver();
      latestBoard = readBoardFromDom(doc);
      if (!latestBoard) {
        latestResult = null;
        rescueHint = null;
        rescueTargetKey = null;
        latestRescueGameKey = null;
        clearHighlights(doc, salt);
        updateExplanation(panel, null);
        updateStatus(panel, null, null);
        updateRescueButton();
        if (attach) attachObserver();
        return;
      }
      latestBoard.totalMines = readTotalMinesFromDom(doc, latestBoard);
      latestResult = solveBoard(latestBoard);
      const gameKey = getRescueGameKey();
      if (gameKey !== latestRescueGameKey) {
        rescueHint = null;
        rescueTargetKey = null;
        latestRescueGameKey = gameKey;
      }
      pruneRescueHint();
      renderHighlights(latestBoard, latestResult, settings, doc, salt, rescueHint);
      updateExplanation(panel, null);
      updateStatus(panel, latestBoard, latestResult, note);
      updateRescueButton();
      if (attach) attachObserver();
    }

    function scheduleAnalyze() {
      if (!shouldAutoAnalyze(settings, analysisVisible)) return;
      if (scheduled) return;
      scheduled = true;
      globalObj.setTimeout(() => {
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
      rescueHint = null;
      rescueTargetKey = null;
      latestRescueGameKey = null;
      updateExplanation(panel, null);
      const status = panel.querySelector("[data-msah-status]");
      if (status) status.textContent = "分析已隐藏。按 ~ 或点击“分析”恢复。";
      updateRescueButton();
    }

    function toggleAnalysis() {
      if (latestResult) {
        clearAnalysis();
      } else {
        analyze({ note: "快捷键" });
      }
    }

    function rescueCurrentTarget() {
      if (!latestBoard || !latestResult) analyze({ attach: false });
      if (!latestBoard || !latestResult) {
        updateStatus(panel, null, null);
        updateRescueButton();
        return;
      }

      const targetCell = getClosedBoardCell(latestBoard, rescueTargetKey);
      if (!isDeadGuessCandidate(latestResult, latestBoard)) {
        updateStatus(panel, latestBoard, latestResult, "当前还有确定结论，未使用救援");
        updateRescueButton();
        return;
      }
      if (!targetCell) {
        updateStatus(panel, latestBoard, latestResult, "先把鼠标移到一个未开格");
        updateRescueButton();
        return;
      }

      const source = getRescueSource();
      const answer = getRescueAnswerFromSource(source, targetCell.key);
      if (!answer) {
        updateStatus(panel, latestBoard, latestResult, "当前局没有可用答案源");
        updateRescueButton();
        return;
      }

      const gameKey = getRescueGameKey();
      const recorded = recordRescueUse(salt, gameKey, targetCell.key, store);
      if (!recorded.ok) {
        updateStatus(panel, latestBoard, latestResult, "本局救援次数已用完");
        updateRescueButton();
        return;
      }

      rescueHint = answer;
      renderHighlights(latestBoard, latestResult, settings, doc, salt, rescueHint);
      updateStatus(
        panel,
        latestBoard,
        latestResult,
        `${formatCellKey(targetCell.key)}${answer.isMine ? "避开" : "可开"}`
      );
      updateRescueButton();
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
      if (action === "rescue") {
        rescueCurrentTarget();
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
      if (!latestBoard || !latestResult || !event.target || typeof event.target.closest !== "function") return;
      const cellElement = event.target.closest("div.cell[id^='cell_']");
      const key = cellElementKey(cellElement);
      if (!key) return;
      const boardCell = latestBoard.byKey && latestBoard.byKey.get(key);
      if (!boardCell || boardCell.element !== cellElement) return;
      if (boardCell.state === "closed") {
        rescueTargetKey = key;
        updateRescueButton();
      }
      if (!settings.showExplanations) return;
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

  if (typeof window !== "undefined") {
    installRescueSocketCapture(window);
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
      applyRescueTouchCells,
      captureRescueClickRequest,
      captureRescueGameInit,
      captureRescueSocketResponse,
      captureRescueTouchUpdate,
      createPanel,
      createRescueState,
      estimateProbabilities,
      findMatchingRescueSource,
      formatExplanation,
      formatExplanationHtml,
      getAllHighlightClasses,
      getHighlightClassNames,
      getHighlightForCell,
      getInstallSalt,
      getRescueAnswerFromSource,
      getRescueRemaining,
      getRescueState,
      getRescueStorageKey,
      getStorageKey,
      getAutoAnalyzeObserverTargets,
      installRescueSocketCapture,
      isAssistantOnlyClassMutation,
      isAnalysisShortcut,
      isBoardStructureMutation,
      isDeadGuessCandidate,
      isEditableElement,
      isRelevantAutoAnalyzeMutation,
      loadSettings,
      loadRescueUsage,
      migrateSettings,
      normalizeBoard,
      readBoardFromDom,
      readRemainingMinesFromDom,
      readTotalMinesFromDom,
      relativeCellName,
      renderHighlights,
      renderExplanationHighlights,
      saveSettings,
      recordRescueUse,
      saveRescueUsage,
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
