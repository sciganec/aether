import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import './App.css';

// ------------------ CONSTANTS ------------------
const ELEMENTS = ['🔥', '💧', '🌍', '💨', '✨', '⚡', '❄️', '🌿'];
const ELEMENT_NAMES = ['Вогонь', 'Вода', 'Земля', 'Повітря', 'Ефір', 'Блискавка', 'Лід', 'Природа'];

const ELEMENT_COLORS_HSL = [
  [10, 90, 60],   // Fire - warm red-orange
  [200, 80, 60],  // Water - deep blue
  [30, 70, 45],   // Earth - brown
  [180, 60, 65],  // Air - cyan
  [260, 75, 70],  // Aether - violet
  [50, 100, 60],  // Lightning - yellow
  [195, 90, 75],  // Ice - light blue
  [130, 65, 50],  // Nature - green
];

const getElementColors = (count) =>
  ELEMENT_COLORS_HSL.slice(0, count).map(([h, s, l]) => `hsl(${h}, ${s}%, ${l}%)`);

const KNIGHT_MOVES = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];

// ------------------ AUDIO ENGINE ------------------
class AudioEngine {
  constructor() {
    this.ctx = null;
  }
  _ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  }
  _tone(freq, type, dur, vol = 0.15, delay = 0) {
    try {
      const ctx = this._ensure();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type; osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + dur);
    } catch {}
  }
  select() { this._tone(440, 'sine', 0.1, 0.1); }
  move() {
    this._tone(330, 'sine', 0.08, 0.1);
    this._tone(495, 'sine', 0.1, 0.08, 0.07);
  }
  merge() {
    [220, 330, 440, 550].forEach((f, i) => this._tone(f, 'triangle', 0.15, 0.12, i * 0.05));
  }
  win() {
    [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 'sine', 0.3, 0.15, i * 0.12));
  }
  undo() { this._tone(220, 'sawtooth', 0.08, 0.08); }
}

const audio = new AudioEngine();

// ------------------ ENGINE HELPERS ------------------
function generateKnightMoveTargets(size) {
  const wrap = (v) => (v + size) % size;
  return Array(size).fill().map((_, r) =>
    Array(size).fill().map((_, c) =>
      KNIGHT_MOVES.map(([dr, dc]) => [wrap(r + dr), wrap(c + dc)])
    )
  );
}

function generateStartingBoard(size, numElements) {
  const board = new Uint8Array(size * size);
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      board[r * size + c] = 1 << ((r + c) % numElements);
  return board;
}

// ------------------ ZOBRIST ------------------
class Zobrist {
  constructor(maxSize = 8) {
    this.table = Array(maxSize * maxSize).fill().map(() => Array(256).fill(0n));
    this.sideToMove = 0n;
    this.init(maxSize);
  }
  random64() {
    const high = BigInt(Math.floor(Math.random() * 0xFFFFFFFF));
    const low = BigInt(Math.floor(Math.random() * 0xFFFFFFFF));
    return (high << 32n) | low;
  }
  init(maxSize) {
    for (let i = 0; i < maxSize * maxSize; i++)
      for (let j = 0; j < 256; j++) this.table[i][j] = this.random64();
    this.sideToMove = this.random64();
  }
}
const zobrist = new Zobrist(8);

// ------------------ BOARD ENGINE ------------------
class DynamicBoardEngine {
  constructor(size = 5, numElements = 5) {
    this.size = size;
    this.numElements = numElements;
    this.winMask = (1 << numElements) - 1;
    this.targets = generateKnightMoveTargets(size);
    this.board = new Uint8Array(size * size);
    this.hash = 0n;
    this.currentPlayer = 0;
    this.winner = null;
    this.moveCount = 0;
    this.searchNodes = 0;
    this.transpositionTable = new Map();
    this.history = [];
    this.reset();
  }

  _idx(r, c) { return r * this.size + c; }
  _getCellRaw(r, c) { return this.board[this._idx(r, c)]; }
  _setCellRaw(r, c, val) { this.board[this._idx(r, c)] = val; }

  countElements(r, c) {
    const val = this._getCellRaw(r, c);
    let count = 0;
    for (let i = 0; i < this.numElements; i++) if (val & (1 << i)) count++;
    return count;
  }

  getAllMoves() {
    const moves = [];
    for (let r = 0; r < this.size; r++)
      for (let c = 0; c < this.size; c++) {
        if (this._getCellRaw(r, c) === 0) continue;
        for (const [tr, tc] of this.targets[r][c]) moves.push({ from: [r, c], to: [tr, tc] });
      }
    return moves;
  }

  // NEW: Find cells one merge away from winning
  getWinningMoves() {
    const winning = [];
    for (let r = 0; r < this.size; r++)
      for (let c = 0; c < this.size; c++) {
        const val = this._getCellRaw(r, c);
        if (val === 0) continue;
        for (const [tr, tc] of this.targets[r][c]) {
          const merged = val | this._getCellRaw(tr, tc);
          if (merged === this.winMask) winning.push({ from: [r, c], to: [tr, tc] });
        }
      }
    return winning;
  }

  // NEW: Get threat map - cells that are one move away from winning
  getThreatMap() {
    const threats = new Set();
    const winning = this.getWinningMoves();
    winning.forEach(m => {
      threats.add(`${m.from[0]},${m.from[1]}`);
      threats.add(`${m.to[0]},${m.to[1]}`);
    });
    return threats;
  }

  _updateHash(r, c, val) {
    const idx = r * this.size + c;
    const oldVal = this._getCellRaw(r, c);
    if (oldVal !== 0) this.hash ^= zobrist.table[idx][oldVal];
    if (val !== 0) this.hash ^= zobrist.table[idx][val];
  }

  saveState() {
    return {
      board: new Uint8Array(this.board),
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      moveCount: this.moveCount,
      hash: this.hash
    };
  }

  loadState(s) {
    this.board = new Uint8Array(s.board);
    this.currentPlayer = s.currentPlayer;
    this.winner = s.winner;
    this.moveCount = s.moveCount;
    this.hash = s.hash;
    this.transpositionTable.clear();
  }

  makeMove(fr, fc, tr, tc) {
    if (this.winner !== null) return false;
    this.history.push(this.saveState());
    const fromVal = this._getCellRaw(fr, fc);
    const newVal = fromVal | this._getCellRaw(tr, tc);
    this._updateHash(fr, fc, 0); this._setCellRaw(fr, fc, 0);
    this._updateHash(tr, tc, newVal); this._setCellRaw(tr, tc, newVal);
    this.moveCount++;
    this.hash ^= zobrist.sideToMove;
    if (newVal === this.winMask) { this.winner = this.currentPlayer; return true; }
    this.currentPlayer = this.currentPlayer === 0 ? 1 : 0;
    return false;
  }

  evaluate() {
    let score = 0;
    const mid = (this.size - 1) / 2;
    for (let r = 0; r < this.size; r++)
      for (let c = 0; c < this.size; c++) {
        const val = this._getCellRaw(r, c);
        if (val === 0) continue;
        const cnt = this.countElements(r, c);
        let mVal = [0, 10, 100, 1000, 10000, 100000, 1000000, 10000000][cnt];
        const dist = Math.abs(r - mid) + Math.abs(c - mid);
        score += mVal + (this.size - dist) * 15;
        if (cnt === this.numElements - 1)
          for (const [tr, tc] of this.targets[r][c])
            if ((val | this._getCellRaw(tr, tc)) === this.winMask) score += 50000;
      }
    return this.currentPlayer === 0 ? score : -score;
  }

  reset() {
    this.board = generateStartingBoard(this.size, this.numElements);
    this.hash = 0n;
    for (let r = 0; r < this.size; r++)
      for (let c = 0; c < this.size; c++)
        if (this._getCellRaw(r, c) !== 0)
          this.hash ^= zobrist.table[r * this.size + c][this._getCellRaw(r, c)];
    this.winner = null;
    this.moveCount = 0;
    this.history = [];
    this.transpositionTable.clear();
  }

  minimax(depth, alpha, beta, isMax, limit) {
    this.searchNodes++;
    if (this.winner !== null) return isMax ? -9999999 : 9999999;
    if (depth === 0 || Date.now() > limit) return this.evaluate();
    const cached = this.transpositionTable.get(this.hash);
    if (cached && cached.depth >= depth) return cached.score;
    const moves = this.getAllMoves();
    moves.sort((a, b) => this._moveGain(b) - this._moveGain(a));
    let bestVal = isMax ? -Infinity : Infinity;
    for (const m of moves) {
      const s = this.saveState();
      this.makeMove(m.from[0], m.from[1], m.to[0], m.to[1]);
      const val = this.minimax(depth - 1, alpha, beta, !isMax, limit);
      this.loadState(s);
      if (isMax) { bestVal = Math.max(bestVal, val); alpha = Math.max(alpha, bestVal); }
      else { bestVal = Math.min(bestVal, val); beta = Math.min(beta, bestVal); }
      if (alpha >= beta) break;
    }
    this.transpositionTable.set(this.hash, { score: bestVal, depth });
    return bestVal;
  }

  _moveGain(move) {
    return this.countElements(move.from[0], move.from[1]) + this.countElements(move.to[0], move.to[1]);
  }

  getAIMove(level) {
    const d = { easy: 1, medium: 2, hard: 3, expert: 3, master: 4, impossible: 5, subit: 6 }[level] || 3;
    const limit = Date.now() + 2000;
    this.searchNodes = 0;
    const moves = this.getAllMoves();
    if (moves.length === 0) return null;
    // Check for immediate win first
    for (const m of moves) {
      const s = this.saveState();
      if (this.makeMove(m.from[0], m.from[1], m.to[0], m.to[1])) { this.loadState(s); return m; }
      this.loadState(s);
    }
    let bMove = null, bScore = -Infinity;
    for (const m of moves) {
      const s = this.saveState();
      this.makeMove(m.from[0], m.from[1], m.to[0], m.to[1]);
      const sc = this.minimax(d - 1, -Infinity, Infinity, false, limit);
      this.loadState(s);
      if (sc > bScore) { bScore = sc; bMove = m; }
      if (this.searchNodes > 500000) break;
    }
    return bMove;
  }
}

// ------------------ HOOKS ------------------
function useEngine(size, numElements) {
  const engineRef = useRef(null);
  if (!engineRef.current || engineRef.current.size !== size || engineRef.current.numElements !== numElements) {
    engineRef.current = new DynamicBoardEngine(size, numElements);
  }
  const genState = (e) => {
    const s = e.size, b = [];
    for (let r = 0; r < s; r++) {
      const row = [];
      for (let c = 0; c < s; c++) {
        const v = e._getCellRaw(r, c), ind = [];
        for (let i = 0; i < e.numElements; i++) if (v & (1 << i)) ind.push(i);
        row.push(ind);
      }
      b.push(row);
    }
    return {
      board: b,
      currentPlayer: e.currentPlayer,
      winner: e.winner,
      moveCount: e.moveCount,
      nodes: e.searchNodes,
      canUndo: e.history.length > 0
    };
  };
  const [state, setState] = useState(() => genState(engineRef.current));
  useEffect(() => { engineRef.current = new DynamicBoardEngine(size, numElements); setState(genState(engineRef.current)); }, [size, numElements]);
  const refresh = useCallback(() => setState(genState(engineRef.current)), []);
  return {
    ...state,
    makeMove: (fr, fc, tr, tc) => { const won = engineRef.current.makeMove(fr, fc, tr, tc); refresh(); return won; },
    resetGame: (fp) => { engineRef.current.currentPlayer = fp; engineRef.current.reset(); refresh(); },
    undo: () => { if (engineRef.current.history.length > 0) { engineRef.current.loadState(engineRef.current.history.pop()); audio.undo(); refresh(); } },
    getAIMove: (l) => engineRef.current.getAIMove(l),
    getWinningMoves: () => engineRef.current.getWinningMoves(),
    getThreatMap: () => engineRef.current.getThreatMap(),
    engine: engineRef.current
  };
}

// ------------------ CONFETTI ------------------
function Confetti({ active }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const particles = Array.from({ length: 120 }, () => ({
      x: Math.random() * canvas.width,
      y: -20,
      vx: (Math.random() - 0.5) * 4,
      vy: Math.random() * 4 + 2,
      color: `hsl(${Math.random() * 360}, 80%, 60%)`,
      size: Math.random() * 8 + 4,
      rotation: Math.random() * 360,
      rotVel: (Math.random() - 0.5) * 8,
    }));
    let raf;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.rotation += p.rotVel; p.vy += 0.1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });
      if (particles.some(p => p.y < canvas.height + 20)) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [active]);
  if (!active) return null;
  return <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 999 }} />;
}

// ------------------ VISUAL PIECE ------------------
const VisualPiece = React.memo(({ indices, theme, colors, isWinner }) => {
  const count = indices.length;
  if (count === 0) return null;
  if (theme === 'colors') {
    if (count === 1) {
      return (
        <div className={`radial-piece ${isWinner ? 'winner-piece' : ''}`}
          style={{ backgroundColor: colors[indices[0]], width: '82%', height: '82%', borderRadius: '50%', boxShadow: `0 0 12px ${colors[indices[0]]}88` }} />
      );
    }
    const step = 360 / count;
    const bg = `conic-gradient(${indices.map((idx, i) => `${colors[idx]} ${i * step}deg ${(i + 1) * step}deg`).join(', ')})`;
    return (
      <div className={`radial-piece ${isWinner ? 'winner-piece' : ''}`}
        style={{ background: bg, width: '82%', height: '82%', borderRadius: '50%', boxShadow: '0 0 14px rgba(255,255,255,0.2)' }} />
    );
  }
  return (
    <div className={`crystal-piece count-${count} ${isWinner ? 'winner-piece' : ''}`}>
      {indices.map(idx => <span key={idx} className={`element elem-${idx + 1}`}>{ELEMENTS[idx]}</span>)}
    </div>
  );
});

// ------------------ BOARD ------------------
const Board = ({ board, theme, selected, validMoves, onCellClick, colors, winningMoves, threatMap, lastMove, showHints }) => {
  const winFrom = showHints ? new Set(winningMoves.map(m => `${m.from[0]},${m.from[1]}`)) : new Set();
  const winTo = showHints ? new Set(winningMoves.map(m => `${m.to[0]},${m.to[1]}`)) : new Set();

  return (
    <div className="board-wrapper">
      <div className="board" style={{ '--board-size': board.length }}>
        {board.map((row, r) => row.map((ind, c) => {
          const key = `${r},${c}`;
          const isSelected = selected?.r === r && selected?.c === c;
          const isValid = validMoves.some(([nr, nc]) => nr === r && nc === c);
          const isLastFrom = lastMove?.from[0] === r && lastMove?.from[1] === c;
          const isLastTo = lastMove?.to[0] === r && lastMove?.to[1] === c;
          const isWinFrom = winFrom.has(key);
          const isWinTo = winTo.has(key);
          const isThreat = showHints && threatMap.has(key) && !isWinFrom && !isWinTo;
          const isEmpty = ind.length === 0;

          return (
            <div
              key={key}
              className={[
                'cell',
                isSelected ? 'selected' : '',
                isValid ? 'valid' : '',
                isLastFrom || isLastTo ? 'last-move' : '',
                isWinFrom ? 'win-hint-from' : '',
                isWinTo ? 'win-hint-to' : '',
                isThreat ? 'threat-cell' : '',
                isEmpty ? 'empty-cell' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onCellClick(r, c)}
            >
              {isValid && isEmpty && <div className="valid-dot" />}
              <VisualPiece indices={ind} theme={theme} colors={colors} />
            </div>
          );
        }))}
      </div>
    </div>
  );
};

// ------------------ TIMER HOOK ------------------
function useTimer(running) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef(null);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now() - elapsed * 1000;
    if (running) {
      ref.current = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 500);
    } else {
      clearInterval(ref.current);
    }
    return () => clearInterval(ref.current);
  }, [running]);

  const reset = useCallback(() => { setElapsed(0); startRef.current = Date.now(); }, []);
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return { elapsed, fmt: fmt(elapsed), reset };
}

// ------------------ MOVE HISTORY ------------------
const MoveHistory = ({ history }) => {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [history]);
  if (!history.length) return null;
  return (
    <div className="move-history glass-panel">
      <div className="section-label">📜 Журнал ходів</div>
      <div ref={ref} className="move-list">
        {history.map((h, i) => (
          <div key={i} className={`move-entry ${h.player === 0 ? 'p1' : 'p2'}`}>
            <span className="move-num">{i + 1}.</span>
            <span className="move-player">{h.player === 0 ? '👤' : '🤖'}</span>
            <span className="move-coords">{String.fromCharCode(65 + h.from[1])}{h.from[0]+1}→{String.fromCharCode(65 + h.to[1])}{h.to[0]+1}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ------------------ INFO CARD ------------------
const InfoCard = ({ cell, colors, numElements }) => {
  if (!cell) return (
    <div className="info-card glass-panel empty-info">
      <div className="info-hint">Оберіть фігуру для аналізу складу</div>
    </div>
  );
  const { indices } = cell;
  const present = indices.map(i => ({ i, name: ELEMENT_NAMES[i], color: colors[i], icon: ELEMENTS[i] }));
  const missing = Array.from({ length: numElements }, (_, i) => i)
    .filter(i => !indices.includes(i))
    .map(i => ({ i, name: ELEMENT_NAMES[i], color: colors[i], icon: ELEMENTS[i] }));
  const completeness = Math.round((indices.length / numElements) * 100);

  return (
    <div className="info-card glass-panel">
      <div className="section-label">Склад фігури</div>
      <div className="completeness-bar">
        <div className="completeness-fill" style={{ width: `${completeness}%` }} />
        <span className="completeness-label">{completeness}%</span>
      </div>
      <div className="el-list">{present.map(p => (
        <span key={p.i} className="el-tag present" style={{ borderLeft: `3px solid ${p.color}` }}>
          {p.icon} {p.name}
        </span>
      ))}</div>
      {missing.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="section-label" style={{ fontSize: '0.65rem', opacity: 0.5 }}>Бракує:</div>
          <div className="el-list">{missing.map(m => (
            <span key={m.i} className="el-tag missing" style={{ borderLeft: `3px solid ${m.color}` }}>
              {m.icon} {m.name}
            </span>
          ))}</div>
        </div>
      )}
    </div>
  );
};

// ------------------ WIN SCREEN ------------------
const WinScreen = ({ winner, gameMode, moveCount, elapsed, onRematch }) => (
  <div className="win-overlay">
    <div className="win-modal glass-panel">
      <div className="win-icon">{winner === 0 ? '👤' : '🤖'}</div>
      <h2 className="win-title">{winner === 0 ? 'Гравець перемагає!' : (gameMode === 'vsAI' ? 'ШІ перемагає!' : 'Гравець 2 перемагає!')}</h2>
      <div className="win-stats">
        <div className="win-stat"><span>⚡ Ходів</span><strong>{moveCount}</strong></div>
        <div className="win-stat"><span>⏱ Час</span><strong>{`${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`}</strong></div>
      </div>
      <button className="rematch-btn" onClick={onRematch}>🔄 Грати знову</button>
    </div>
  </div>
);

// ------------------ MAIN APP ------------------
function App() {
  const [boardSize, setBoardSize] = useState(5);
  const [numElements, setNumElements] = useState(5);
  const [theme, setTheme] = useState('elements');
  const [gameMode, setGameMode] = useState('vsAI');
  const [aiDifficulty, setAiDifficulty] = useState('medium');
  const [firstPlayer] = useState(0);

  const [selected, setSelected] = useState(null);
  const [validMoves, setValidMoves] = useState([]);
  const [aiThinking, setAiThinking] = useState(false);
  const [infoCell, setInfoCell] = useState(null);
  const [showHints, setShowHints] = useState(true);
  const [moveHistory, setMoveHistory] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  const [showWin, setShowWin] = useState(false);

  const colors = useMemo(() => getElementColors(numElements), [numElements]);

  const { board, currentPlayer, winner, moveCount, nodes, canUndo, makeMove, resetGame, getAIMove, getWinningMoves, getThreatMap, engine, undo } = useEngine(boardSize, numElements);
  const thinkRef = useRef(false);
  const timer = useTimer(winner === null && !showWin);

  const winningMoves = useMemo(() => showHints && winner === null ? getWinningMoves() : [], [board, showHints, winner]);
  const threatMap = useMemo(() => showHints && winner === null ? getThreatMap() : new Set(), [board, showHints, winner]);

  useEffect(() => {
    if (winner !== null && !showWin) {
      audio.win();
      setTimeout(() => setShowWin(true), 400);
    }
  }, [winner]);

  const handleRematch = useCallback(() => {
    setShowWin(false);
    setMoveHistory([]);
    setLastMove(null);
    setSelected(null);
    setValidMoves([]);
    setInfoCell(null);
    timer.reset();
    resetGame(firstPlayer);
  }, [resetGame, firstPlayer, timer]);

  const handleNewGame = useCallback(() => {
    setShowWin(false);
    setMoveHistory([]);
    setLastMove(null);
    setSelected(null);
    setValidMoves([]);
    setInfoCell(null);
    timer.reset();
    resetGame(firstPlayer);
  }, [resetGame, firstPlayer, timer]);

  const onCellClick = useCallback((r, c) => {
    if (winner !== null || aiThinking) return;
    if (gameMode === 'vsAI' && currentPlayer === 1) return;
    const ind = board[r][c];

    if (!selected) {
      if (ind.length > 0) {
        audio.select();
        setSelected({ r, c });
        setValidMoves(engine.targets[r][c]);
        setInfoCell({ r, c, indices: ind });
      }
    } else {
      const isValid = validMoves.some(([nr, nc]) => nr === r && nc === c);
      if (isValid) {
        const fromVal = engine._getCellRaw(selected.r, selected.c);
        const toVal = engine._getCellRaw(r, c);
        const merged = fromVal | toVal;
        if (merged === engine.winMask) audio.merge();
        else if (toVal !== 0) audio.merge();
        else audio.move();
        makeMove(selected.r, selected.c, r, c);
        setMoveHistory(prev => [...prev, { from: [selected.r, selected.c], to: [r, c], player: currentPlayer }]);
        setLastMove({ from: [selected.r, selected.c], to: [r, c] });
        setSelected(null);
        setValidMoves([]);
        setInfoCell(null);
      } else if (r === selected.r && c === selected.c) {
        setSelected(null);
        setValidMoves([]);
        setInfoCell(null);
      } else if (ind.length > 0) {
        audio.select();
        setSelected({ r, c });
        setValidMoves(engine.targets[r][c]);
        setInfoCell({ r, c, indices: ind });
      } else {
        setSelected(null);
        setValidMoves([]);
        setInfoCell(null);
      }
    }
  }, [winner, aiThinking, gameMode, currentPlayer, board, selected, validMoves, engine, makeMove]);

  useEffect(() => {
    if (gameMode === 'vsAI' && currentPlayer === 1 && winner === null && !thinkRef.current) {
      thinkRef.current = true;
      setAiThinking(true);
      const delay = aiDifficulty === 'easy' ? 600 : 1200;
      setTimeout(() => {
        const m = getAIMove(aiDifficulty);
        if (m) {
          audio.move();
          makeMove(m.from[0], m.from[1], m.to[0], m.to[1]);
          setMoveHistory(prev => [...prev, { from: m.from, to: m.to, player: 1 }]);
          setLastMove({ from: m.from, to: m.to });
        }
        setAiThinking(false);
        thinkRef.current = false;
      }, delay);
    }
  }, [currentPlayer, winner, gameMode, aiDifficulty, getAIMove, makeMove]);

  const elementCounts = useMemo(() => {
    const counts = Array(numElements).fill(0);
    board.forEach(row => row.forEach(ind => ind.forEach(i => i < numElements && counts[i]++)));
    return counts;
  }, [board, numElements]);

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    // Undo twice in vsAI mode to undo AI's response too
    undo();
    if (gameMode === 'vsAI' && engine.history.length > 0) undo();
    setSelected(null);
    setValidMoves([]);
    setInfoCell(null);
    setLastMove(null);
    setMoveHistory(prev => {
      const next = [...prev];
      next.pop();
      if (gameMode === 'vsAI') next.pop();
      return next;
    });
  }, [canUndo, undo, gameMode, engine]);

  return (
    <div className="aether-game">
      <Confetti active={showWin} />
      {showWin && <WinScreen winner={winner} gameMode={gameMode} moveCount={moveCount} elapsed={timer.elapsed} onRematch={handleRematch} />}

      <header className="game-header">
        <h1 className="game-title">AETHER <span>ULTIMATE</span></h1>
        <div className="header-badges">
          <div className="timer-badge">{timer.fmt}</div>
          <div className="move-badge">Хід {moveCount + 1}</div>
        </div>
      </header>

      {/* Control Panel */}
      <div className="control-strip glass-panel">
        <div className="control-group">
          <span className="ctrl-label">Поле</span>
          <div className="seg-ctrl">{[3,4,5,6,7,8].map(s => (
            <button key={s} className={boardSize===s?'active':''} onClick={()=>{setBoardSize(s); handleNewGame();}}>{s}×{s}</button>
          ))}</div>
        </div>
        <div className="control-group">
          <span className="ctrl-label">Стихії</span>
          <div className="seg-ctrl">{[3,4,5,6,7,8].filter(v=>v<=boardSize).map(k => (
            <button key={k} className={numElements===k?'active':''} onClick={()=>{setNumElements(k); handleNewGame();}}>{k}</button>
          ))}</div>
        </div>
        <div className="control-group">
          <span className="ctrl-label">Режим</span>
          <div className="seg-ctrl">
            <button className={gameMode==='twoPlayer'?'active':''} onClick={()=>setGameMode('twoPlayer')}>👥</button>
            <button className={gameMode==='vsAI'?'active':''} onClick={()=>setGameMode('vsAI')}>🤖</button>
          </div>
        </div>
        {gameMode==='vsAI' && (
          <div className="control-group">
            <span className="ctrl-label">Рівень ШІ</span>
            <div className="seg-ctrl" style={{fontSize:'0.6rem'}}>
              {['easy','medium','hard','expert','impossible'].map(l=>(
                <button key={l} className={aiDifficulty===l?'active':''} onClick={()=>setAiDifficulty(l)}>{
                  {easy:'Легко',medium:'Середн.',hard:'Важко',expert:'Екс.',impossible:'∞'}[l]
                }</button>
              ))}
            </div>
          </div>
        )}
        <div className="control-group">
          <span className="ctrl-label">Вигляд</span>
          <div className="seg-ctrl">
            <button className={theme==='elements'?'active':''} onClick={()=>setTheme('elements')}>🔮</button>
            <button className={theme==='colors'?'active':''} onClick={()=>setTheme('colors')}>🌈</button>
          </div>
        </div>
        <div className="control-group">
          <span className="ctrl-label">Підказки</span>
          <div className="seg-ctrl">
            <button className={showHints?'active':''} onClick={()=>setShowHints(!showHints)}>{showHints?'✅':'⬜'}</button>
          </div>
        </div>
        <button className="new-game-btn" onClick={handleNewGame}>🔄 НОВА ГРА</button>
      </div>

      {/* Status Bar */}
      <div className={`status-bar ${winner !== null ? 'won' : ''} ${currentPlayer === 0 ? 'p1-turn' : 'p2-turn'}`}>
        {winner !== null ? (
          <span>🏆 {winner === 0 ? 'Гравець переміг!' : (gameMode === 'vsAI' ? 'ШІ переміг!' : 'Гравець 2 переміг!')}</span>
        ) : aiThinking ? (
          <span className="thinking-pulse">🤖 Аналізую позицію... <span className="node-count">({nodes} вузлів)</span></span>
        ) : (
          <span>{currentPlayer === 0 ? '👤 Ваш хід' : (gameMode === 'vsAI' ? '🤖 Хід ШІ' : '👤 Хід гравця 2')}</span>
        )}
        {winningMoves.length > 0 && winner === null && (
          <span className="hint-badge">💡 {winningMoves.length} виграшних ходи</span>
        )}
      </div>

      {/* Main Game Area */}
      <div className="game-area">
        <Board
          board={board}
          theme={theme}
          selected={selected}
          validMoves={validMoves}
          onCellClick={onCellClick}
          colors={colors}
          winningMoves={winningMoves}
          threatMap={threatMap}
          lastMove={lastMove}
          showHints={showHints}
        />

        <div className="side-panel">
          <InfoCard cell={infoCell} colors={colors} numElements={numElements} />

          <div className="element-stats glass-panel">
            <div className="section-label">Баланс стихій</div>
            <div className="element-grid">
              {ELEMENTS.slice(0, numElements).map((el, i) => (
                <div key={el} className="el-stat-item" style={{ '--el-color': colors[i] }}>
                  <span className="el-stat-icon">{el}</span>
                  <div className="el-stat-bar-wrap">
                    <div className="el-stat-bar" style={{ width: `${Math.min(100, elementCounts[i] * 10)}%`, background: colors[i] }} />
                  </div>
                  <span className="el-stat-count">{elementCounts[i]}</span>
                </div>
              ))}
            </div>
          </div>

          <MoveHistory history={moveHistory} />

          <button
            className={`undo-btn ${!canUndo ? 'disabled' : ''}`}
            onClick={handleUndo}
            disabled={!canUndo}
          >
            🔙 Відмінити хід
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
