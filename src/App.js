import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';

// ------------------ КОНСТАНТИ ------------------
const ELEMENTS = ['🔥', '💧', '🌍', '💨'];
const ELEMENT_BITS = { '🔥': 1, '💧': 2, '🌍': 4, '💨': 8 };

const ELEMENT_COUNT_TABLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

const KNIGHT_MOVES = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
];

const OPENING_BOOK = [
  { from: [1, 1], to: [3, 0], weight: 10 },
  { from: [1, 2], to: [3, 3], weight: 10 },
  { from: [2, 1], to: [0, 0], weight: 9 },
  { from: [2, 2], to: [0, 3], weight: 9 },
  { from: [1, 0], to: [3, 1], weight: 8 },
  { from: [1, 3], to: [3, 2], weight: 8 },
];

// ------------------ DYNAMIC ENGINE HELPERS ------------------

function generateKnightMoveTargets(size) {
  return Array(size)
    .fill()
    .map((_, r) =>
      Array(size)
        .fill()
        .map((_, c) =>
          KNIGHT_MOVES.map(([dr, dc]) => [
            (r + dr + size) % size,
            (c + dc + size) % size,
          ])
        )
    );
}

function generateStartingBoard(size) {
  const board = new Uint8Array(size * size);
  if (size === 4) {
    // Original 4x4 Latin Square
    const LATIN_SQUARE_4 = [
      [1, 2, 4, 8],
      [2, 4, 8, 1],
      [4, 8, 1, 2],
      [8, 1, 2, 4],
    ];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        board[r * 4 + c] = LATIN_SQUARE_4[r][c];
      }
    }
  } else if (size === 6) {
    // 6x6 Pattern ensure each element is present
    const pattern = [1, 2, 4, 8, 1, 2];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        board[r * 6 + c] = pattern[(r + c) % pattern.length];
      }
    }
  }
  return board;
}

// ------------------ ZOBRIST TABLE ------------------
class Zobrist {
  constructor(maxSize = 6) {
    this.table = Array(maxSize * maxSize).fill().map(() => Array(16).fill(0n));
    this.sideToMove = 0n;
    this.init(maxSize);
  }

  random64() {
    const high = BigInt(Math.floor(Math.random() * 0xFFFFFFFF));
    const low = BigInt(Math.floor(Math.random() * 0xFFFFFFFF));
    return (high << 32n) | low;
  }

  init(maxSize) {
    for (let i = 0; i < maxSize * maxSize; i++) {
      for (let j = 0; j < 16; j++) {
        this.table[i][j] = this.random64();
      }
    }
    this.sideToMove = this.random64();
  }
}

const zobrist = new Zobrist(6); // Allocate for up to 6x6

// ------------------ ЛОГЕР ------------------
class Logger {
  constructor() {
    this.logs = [];
  }

  add(type, message) {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.push(`[${timestamp}] [${type}] ${message}`);
    console.log(`[${type}] ${message}`);
  }

  clear() {
    this.logs = [];
  }

  getText() {
    return this.logs.join('\n');
  }
}

const logger = new Logger();

// ------------------ ДВИГУН (ArrayBoard) ------------------
class DynamicBoardEngine {
  constructor(size = 4) {
    this.size = size;
    this.targets = generateKnightMoveTargets(size);
    this.board = new Uint8Array(size * size);
    this.hash = 0n;
    this.currentPlayer = 0;
    this.winner = null;
    this.moveCount = 0;
    this.searchCounter = { count: 0 };
    this.maxNodes = 250000;
    this.maxNodesSUBIT = 500000;
    this.season = 0;
    this.transpositionTable = new Map();
    this.error = null;
    this.history = [];
    this.reset();
  }

  _idx(r, c) {
    return r * this.size + c;
  }

  _getCellRaw(r, c) {
    return this.board[this._idx(r, c)];
  }

  _setCellRaw(r, c, val) {
    this.board[this._idx(r, c)] = val;
  }

  getCell(r, c) {
    const val = this._getCellRaw(r, c);
    const result = [];
    if (val & 1) result.push('🔥');
    if (val & 2) result.push('💧');
    if (val & 4) result.push('🌍');
    if (val & 8) result.push('💨');
    return result;
  }

  countElements(r, c) {
    const val = this._getCellRaw(r, c);
    return ELEMENT_COUNT_TABLE[val];
  }

  getAllMoves() {
    const moves = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        const val = this._getCellRaw(r, c);
        if (val === 0) continue;
        const targets = this.targets[r][c];
        for (const [tr, tc] of targets) {
          moves.push({ from: [r, c], to: [tr, tc] });
        }
      }
    }
    return moves;
  }

  _moveGain(move) {
    const fromVal = this._getCellRaw(move.from[0], move.from[1]);
    const toVal = this._getCellRaw(move.to[0], move.to[1]);
    if (toVal === 0) {
      return this.countElements(move.from[0], move.from[1]);
    } else {
      const merged = fromVal | toVal;
      let cnt = 0;
      if (merged & 1) cnt++;
      if (merged & 2) cnt++;
      if (merged & 4) cnt++;
      if (merged & 8) cnt++;
      return cnt;
    }
  }

  _updateHash(r, c, val) {
    const idx = r * this.size + c;
    const oldVal = this._getCellRaw(r, c);
    if (oldVal !== 0) this.hash ^= zobrist.table[idx][oldVal];
    if (val !== 0) this.hash ^= zobrist.table[idx][val];
  }

  makeMove(fr, fc, tr, tc) {
    if (this.winner !== null) return false;

    // Save state before move
    this.history.push(this.saveState());

    const fromVal = this._getCellRaw(fr, fc);
    if (fromVal === 0) return false;

    const toVal = this._getCellRaw(tr, tc);
    let newVal;
    if (toVal === 0) {
      newVal = fromVal;
    } else {
      newVal = fromVal | toVal;
    }

    this._updateHash(fr, fc, 0); 
    this._setCellRaw(fr, fc, 0);

    this._updateHash(tr, tc, newVal); 
    this._setCellRaw(tr, tc, newVal);

    this.moveCount++;
    this.season = (this.season + 1) % 4;
    this.hash ^= zobrist.sideToMove; 

    logger.add('MOVE', `Гравець ${this.currentPlayer} хід: (${fr},${fc}) -> (${tr},${tc})`);

    if (newVal === 15) {
      this.winner = this.currentPlayer;
      logger.add('WIN', `Гравець ${this.currentPlayer} переміг!`);
      return true;
    }

    this.currentPlayer = this.currentPlayer === 0 ? 1 : 0;
    return false;
  }

  evaluateMaterial() {
    let score = 0;
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        score += this.countElements(r, c) * 100;
      }
    }
    return score;
  }

  evaluateCenter() {
    let score = 0;
    const mid = Math.floor(this.size / 2);
    for (let r = mid - 1; r <= mid; r++) {
      for (let c = mid - 1; c <= mid; c++) {
        score += this.countElements(r, c) * 20;
      }
    }
    return score;
  }

  evaluateMobility() {
    let score = 0;
    const moves = this.getAllMoves();
    for (const move of moves) {
      const fromVal = this._getCellRaw(move.from[0], move.from[1]);
      let cnt = 0;
      if (fromVal & 1) cnt++;
      if (fromVal & 2) cnt++;
      if (fromVal & 4) cnt++;
      if (fromVal & 8) cnt++;
      score += cnt * 2;
    }
    return score;
  }

  _isWinningThreat(r, c, player) {
    const val = this._getCellRaw(r, c);
    if (ELEMENT_COUNT_TABLE[val] !== 3) return false;
    
    const targets = this.targets[r][c];
    for (const [tr, tc] of targets) {
      const tVal = this._getCellRaw(tr, tc);
      if (tVal > 0 && (val | tVal) === 15) return true;
    }
    return false;
  }

  evaluate() {
    let score = 0;
    let threatsSelf = 0;
    let threatsOpp = 0;

    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        const val = this._getCellRaw(r, c);
        const cnt = ELEMENT_COUNT_TABLE[val];
        
        // Non-linear material value
        let material = [0, 10, 50, 200, 1000][cnt];
        
        // Distance to "15" heuristic
        
        if (cnt === 3) {
          const targets = this.targets[r][c];
          let canFinish = false;
          for (const [tr, tc] of targets) {
            const tVal = this._getCellRaw(tr, tc);
            if (tVal > 0 && (val | tVal) === 15) {
              canFinish = true;
            }
          }
          
          if (canFinish) {
            threatsSelf++;
            score += 5000;
          }
        }
        
        score += material;
      }
    }

    // Fork Bonus: Multiple winning threats
    if (threatsSelf > 1) {
      score += 15000; // Stronger fork reward
    }
    
    // Anti-Blunder: if we left a threat that the opponent can take NEXT TURN.
    // In our simplified static eval, since we don't know who moves next strictly from the board state inside `evaluate`
    // wait, we DO know whose turn it is (this.currentPlayer).
    // If it's Player 0's turn to move, and there is a threat, they will take it.
    // If we are evaluating for Player 1, and it's Player 0's turn...
    // Let's refine: If threats > 0, the one whose turn it is wins.
    if (threatsSelf > 0) {
        // If it's Player 1 evaluating this position and it's Player 1's turn
        if (this.currentPlayer === 1) score += 20000; 
        else score -= 20000; // Left a mate-in-1 for the opponent!
    }

    return score;
  }

  isInCheck() {
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.countElements(r, c) === 3) {
          const targets = this.targets[r][c];
          for (const [tr, tc] of targets) {
            if (this.countElements(tr, tc) > 0) {
              const merged = this._getCellRaw(r, c) | this._getCellRaw(tr, tc);
              if (merged === 15) return true;
            }
          }
        }
      }
    }
    return false;
  }

  nullMoveSearch(depth) {
    if (depth <= 0) return this.evaluate();
    return this.evaluate();
  }

  hashPosition() {
    return this.hash;
  }

  alphaBeta(depth, alpha, beta, maximizing) {
    this.searchCounter.count++;

    if (this.searchCounter.count >= this.maxNodes) {
      return this.evaluate();
    }

    // TT Lookup
    const posKey = this.hashPosition();
    const ttEntry = this.transpositionTable.get(posKey);
    if (ttEntry && ttEntry.depth >= depth) {
      if (ttEntry.flag === 'EXACT') return ttEntry.score;
      if (ttEntry.flag === 'LOWER' && ttEntry.score >= beta) return ttEntry.score;
      if (ttEntry.flag === 'UPPER' && ttEntry.score <= alpha) return ttEntry.score;
    }

    if (this.winner !== null) {
      // The AI is player 1. If player 1 wins, it's a huge positive score.
      // If player 0 (human) wins, it's a huge negative score.
      // We still add/subtract depth to prefer shorter paths to winning.
      return this.winner === 1 ? 1000000 + depth : -1000000 - depth;
    }

    if (depth === 0) {
      return this.evaluate();
    }

    const moves = this.getAllMoves();
    if (moves.length === 0) return this.evaluate();

    // Move Ordering
    moves.sort((a, b) => {
      // TT Best Move priority
      if (ttEntry && ttEntry.bestMove) {
        const isABest = a.from[0] === ttEntry.bestMove.from[0] && a.from[1] === ttEntry.bestMove.from[1] &&
                        a.to[0] === ttEntry.bestMove.to[0] && a.to[1] === ttEntry.bestMove.to[1];
        if (isABest) return -1;
      }
      return this._moveGain(b) - this._moveGain(a);
    });

    let bestMoveSoFar = null;
    let originalAlpha = alpha;

    if (maximizing) {
      let value = -Infinity;
      for (const move of moves) {
        if (this.searchCounter.count >= this.maxNodes) break;
        const child = this.clone();
        child.makeMove(...move.from, ...move.to);
        const score = child.alphaBeta(depth - 1, alpha, beta, false);
        if (score > value) {
          value = score;
          bestMoveSoFar = move;
        }
        alpha = Math.max(alpha, value);
        if (beta <= alpha) break;
      }
      
      let flag = 'EXACT';
      if (value <= originalAlpha) flag = 'UPPER';
      else if (value >= beta) flag = 'LOWER';
      this.transpositionTable.set(posKey, { score: value, depth, flag, bestMove: bestMoveSoFar });
      
      return value;
    } else {
      let value = Infinity;
      for (const move of moves) {
        if (this.searchCounter.count >= this.maxNodes) break;
        const child = this.clone();
        child.makeMove(...move.from, ...move.to);
        const score = child.alphaBeta(depth - 1, alpha, beta, true);
        if (score < value) {
          value = score;
          bestMoveSoFar = move;
        }
        beta = Math.min(beta, value);
        if (beta <= alpha) break;
      }

      let flag = 'EXACT';
      if (value >= beta) flag = 'LOWER';
      else if (value <= originalAlpha) flag = 'UPPER';
      this.transpositionTable.set(posKey, { score: value, depth, flag, bestMove: bestMoveSoFar });

      return value;
    }
  }

  getAIMove(level) {
    try {
      const moves = this.getAllMoves();
      if (moves.length === 0) {
        logger.add('AI', 'Немає доступних ходів');
        return null;
      }

      if (level === 'easy') {
        let best = moves[0];
        let bestGain = this._moveGain(best);
        for (let i = 1; i < moves.length; i++) {
          const gain = this._moveGain(moves[i]);
          if (gain > bestGain) {
            bestGain = gain;
            best = moves[i];
          }
        }
        logger.add('AI', `Easy обрав хід (${best.from[0]},${best.from[1]}) -> (${best.to[0]},${best.to[1]})`);
        return best;
      }

      if (this.size === 4 && this.moveCount < 2 && OPENING_BOOK.length > 0) {
        const validOpenings = OPENING_BOOK.filter(
          (move) => this._getCellRaw(move.from[0], move.from[1]) !== 0
        );
        if (validOpenings.length > 0) {
          const totalWeight = validOpenings.reduce((sum, e) => sum + e.weight, 0);
          let rand = Math.random() * totalWeight;
          for (const entry of validOpenings) {
            if (rand < entry.weight) {
              logger.add('AI', `Дебютна книга: (${entry.from[0]},${entry.from[1]}) -> (${entry.to[0]},${entry.to[1]})`);
              return entry;
            }
            rand -= entry.weight;
          }
        }
      }

      const depths = {
        medium: 2,
        hard: 3,
        expert: 4,
        master: 5,
        impossible: 6,
        subit: 8,
      };
      
      let depth = depths[level] || 2;
      let nodesLimit = ['impossible', 'subit'].includes(level) ? this.maxNodesSUBIT : this.maxNodes;
      
      // 6x6 board has a massive branching factor. We must scale down constraints.
      if (this.size === 6) {
        depth = Math.max(1, depth - 1); 
        nodesLimit = Math.floor(nodesLimit / 3); 
      }

      this.searchCounter.count = 0;
      const startTime = Date.now();
      const timeLimit = ['master', 'impossible', 'subit'].includes(level) ? 3500 : 1500;

      let bestMoveGlobal = moves[0];
      let bestScoreGlobal = -Infinity;

      // Iterative Deepening
      for (let d = 1; d <= depth; d++) {
        let currentBestMove = null;
        let currentBestScore = -Infinity;

        // Sort moves based on TT for the current position if available
        const posKey = this.hashPosition();
        const ttEntry = this.transpositionTable.get(posKey);
        moves.sort((a, b) => {
          if (ttEntry && ttEntry.bestMove) {
            const isABest = a.from[0] === ttEntry.bestMove.from[0] && a.from[1] === ttEntry.bestMove.from[1] &&
                            a.to[0] === ttEntry.bestMove.to[0] && a.to[1] === ttEntry.bestMove.to[1];
            if (isABest) return -1;
          }
          return this._moveGain(b) - this._moveGain(a);
        });

        for (const move of moves) {
          if (this.searchCounter.count >= nodesLimit) break;
          if (Date.now() - startTime > timeLimit) break;

          const child = this.clone();
          child.makeMove(...move.from, ...move.to);
          const score = child.alphaBeta(d - 1, -Infinity, Infinity, false);
          if (score > currentBestScore) {
            currentBestScore = score;
            currentBestMove = move;
          }
        }

        if (currentBestMove) {
          bestMoveGlobal = currentBestMove;
          bestScoreGlobal = currentBestScore;
        }

        if (Date.now() - startTime > timeLimit || this.searchCounter.count >= nodesLimit) break;
      }

      logger.add('AI', `Рівень ${level} (ID вузлів ${this.searchCounter.count}) обрав (${bestMoveGlobal.from[0]},${bestMoveGlobal.from[1]}) -> (${bestMoveGlobal.to[0]},${bestMoveGlobal.to[1]}) оцінка ${bestScoreGlobal}`);
      return bestMoveGlobal;
    } catch (e) {
      this.error = e.message;
      logger.add('ERROR', `Помилка в getAIMove: ${e.message}`);
      return null;
    }
  }

  reset() {
    this.board = generateStartingBoard(this.size);
    this.hash = 0n;
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        const val = this._getCellRaw(r, c);
        this.hash ^= zobrist.table[r * this.size + c][val];
      }
    }
    if (this.currentPlayer === 1) this.hash ^= zobrist.sideToMove;
    this.currentPlayer = 0;
    this.winner = null;
    this.moveCount = 0;
    this.searchCounter.count = 0;
    this.season = Math.floor(Math.random() * 4);
    this.transpositionTable.clear();
    this.error = null;
    this.history = [];
    logger.add('INFO', `Гру скинуто (розмір ${this.size}x${this.size})`);
  }

  saveState() {
    return {
      board: new Uint8Array(this.board),
      hash: this.hash,
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      moveCount: this.moveCount,
      season: this.season
    };
  }

  restoreState(state) {
    this.board = new Uint8Array(state.board);
    this.hash = state.hash;
    this.currentPlayer = state.currentPlayer;
    this.winner = state.winner;
    this.moveCount = state.moveCount;
    this.season = state.season;
    this.error = null;
  }

  undo() {
    if (this.history.length === 0) return false;
    const previousState = this.history.pop();
    this.restoreState(previousState);
    logger.add('UNDO', 'Останній хід скасовано');
    return true;
  }

  clone() {
    const c = Object.create(DynamicBoardEngine.prototype);
    c.size = this.size;
    c.targets = this.targets; // can share reference as it's static
    c.board = new Uint8Array(this.board);
    c.hash = this.hash;
    c.currentPlayer = this.currentPlayer;
    c.winner = this.winner;
    c.moveCount = this.moveCount;
    c.searchCounter = this.searchCounter; // shared reference!
    c.maxNodes = this.maxNodes;
    c.maxNodesSUBIT = this.maxNodesSUBIT;
    c.season = this.season;
    c.transpositionTable = this.transpositionTable;
    c.error = this.error;
    c.history = [...this.history];
    return c;
  }
}

// ------------------ ХУК useEngine ------------------
function useEngine(size = 4) {
  const engineRef = useRef(null);
  const prevSizeRef = useRef(size);
  
  const generateStateFromEngine = (eng) => {
    const currentSize = eng.size;
    const b = [];
    for (let r = 0; r < currentSize; r++) {
      const row = [];
      for (let c = 0; c < currentSize; c++) {
        row.push(eng.getCell(r, c));
      }
      b.push(row);
    }
    return {
      board: b,
      currentPlayer: eng.currentPlayer,
      winner: eng.winner,
      moveCount: eng.moveCount,
      nodes: eng.searchCounter.count,
      error: eng.error,
    };
  };

  if (!engineRef.current || prevSizeRef.current !== size) {
    engineRef.current = new DynamicBoardEngine(size);
    prevSizeRef.current = size;
  }

  const [state, setState] = useState(() => generateStateFromEngine(engineRef.current));

  // If size changed, force sync state during render (derived state pattern)
  if (state.board.length !== size) {
    setState(generateStateFromEngine(engineRef.current));
  }

  const refresh = useCallback(() => {
    if (engineRef.current) {
      setState(generateStateFromEngine(engineRef.current));
    }
  }, []);

  const makeMove = useCallback(
    (fr, fc, tr, tc) => {
      engineRef.current.makeMove(fr, fc, tr, tc);
      refresh();
    },
    [refresh]
  );

  const resetGame = useCallback(
    (startingPlayer = 0) => {
      engineRef.current.reset();
      if (startingPlayer === 1) {
        engineRef.current.currentPlayer = 1;
        engineRef.current.hash ^= zobrist.sideToMove;
      }
      refresh();
    },
    [refresh]
  );

  const getAIMove = useCallback((level) => {
    engineRef.current.error = null;
    return engineRef.current.getAIMove(level);
  }, []);

  const undo = useCallback(() => {
    engineRef.current.undo();
    refresh();
  }, [refresh]);

  return {
    ...state,
    engine: engineRef.current, // Expose engine for advanced features
    makeMove,
    resetGame,
    getAIMove,
    refresh,
    undo,
  };
}

// ------------------ КОМПОНЕНТИ ------------------
const Cell = React.memo(({ r, c, value, isSelected, isValid, onClick, onDragStart, onDragOver, onDrop }) => {
  const count = value.length;
  
  return (
    <div
      className={`cell ${isSelected ? 'selected' : ''} ${isValid ? 'valid' : ''} count-${count}`}
      onClick={onClick}
      draggable={count > 0}
      onDragStart={(e) => onDragStart(e, r, c)}
      onDragOver={(e) => onDragOver(e, r, c)}
      onDrop={(e) => onDrop(e, r, c)}
    >
      <div className="cell-grid">
        {value.map((elem, idx) => (
          <span key={idx} className={`element elem-${idx+1}`}>
            {elem}
          </span>
        ))}
      </div>
    </div>
  );
});

const Board = ({ board, selected, validMoves, hint, onCellClick, onDragStart, onDragOver, onDrop }) => {
  const size = board.length;

  return (
    <div className="board-container">
      <div className="board" style={{ '--board-size': size }}>
        {board.map((row, r) => 
          row.map((cell, c) => {
            const isSelected = selected?.r === r && selected?.c === c;
            const isValid = validMoves.some(([nr, nc]) => nr === r && nc === c);
            const isHint = hint && ((hint.from[0] === r && hint.from[1] === c) || (hint.to[0] === r && hint.to[1] === c));
            
            return (
              <Cell
                key={`${r}-${c}`}
                r={r}
                c={c}
                value={cell}
                isSelected={isSelected}
                isValid={isValid}
                onClick={() => onCellClick(r, c)}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
              />
            );
          })
        )}
      </div>
    </div>
  );
};

const ControlPanel = ({
  gameMode,
  setGameMode,
  aiDifficulty,
  setAiDifficulty,
  firstPlayer,
  setFirstPlayer,
  boardSize,
  setBoardSize,
  onReset,
  winner,
  currentPlayer,
  moveCount,
}) => {
  const difficultyName = {
    easy: 'Легкий',
    medium: 'Середній',
    hard: 'Складний',
    expert: 'Експерт',
    master: 'Master',
    impossible: 'Impossible',
    subit: 'SUBIT',
  };

  const cycleDifficulty = () => {
    const levels = ['easy', 'medium', 'hard', 'expert', 'master', 'impossible', 'subit'];
    const next = (levels.indexOf(aiDifficulty) + 1) % levels.length;
    setAiDifficulty(levels[next]);
  };

  return (
    <div className="control-panel">
      <div className="game-status">
        {winner !== null ? (
          <div className="badge winner">🏆 ГРА ЗАКІНЧЕНА</div>
        ) : (
          <div className="badge turn-badge">
            {currentPlayer === 0 ? '👤 Твій хід' : '🤖 ШІ думає...'}
          </div>
        )}
        <div className="badge move-counter">Хід #{moveCount + 1}</div>
      </div>

      <div className="mode-selector">
        <button
          className={gameMode === 'twoPlayer' ? 'active' : ''}
          onClick={() => setGameMode('twoPlayer')}
        >
          👥 2 гравці
        </button>
        <button
          className={gameMode === 'vsAI' ? 'active' : ''}
          onClick={() => setGameMode('vsAI')}
        >
          🤖 Проти ШІ
        </button>
        {gameMode === 'vsAI' && (
          <button className="difficulty-btn" onClick={cycleDifficulty}>
            🧠 {difficultyName[aiDifficulty]}
          </button>
        )}
      </div>
      
      <div className="mode-selector">
        <button
          className={boardSize === 4 ? 'active' : ''}
          onClick={() => setBoardSize(4)}
        >
          🔲 4x4
        </button>
        <button
          className={boardSize === 6 ? 'active' : ''}
          onClick={() => setBoardSize(6)}
        >
          🔳 6x6
        </button>
        <button onClick={onReset}>🔄 Нова гра</button>
      </div>

      {gameMode === 'vsAI' && (
        <div className="first-player-selector">
          <button
            className={firstPlayer === 0 ? 'active' : ''}
            onClick={() => setFirstPlayer(0)}
          >
            👤 Людина починає
          </button>
          <button
            className={firstPlayer === 1 ? 'active' : ''}
            onClick={() => setFirstPlayer(1)}
          >
            🤖 ШІ починає
          </button>
        </div>
      )}
    </div>
  );
};

const StatsPanel = ({ elementCounts, gameMode, aiDifficulty, nodes }) => {
  return (
    <div className="stats-panel">
      <div className="element-stats">
        {ELEMENTS.map((elem) => (
          <div key={elem} className="element-stat">
            <span className="element-icon">{elem}</span>
            <span className="element-count">{elementCounts[elem]}</span>
          </div>
        ))}
      </div>
      {gameMode === 'vsAI' && ['master', 'impossible', 'subit'].includes(aiDifficulty) && (
        <div className="engine-stats">
          <div>Вузлів: {nodes}</div>
        </div>
      )}
    </div>
  );
};

const LogPanel = ({ logText, onCopy, onClear }) => {
  return (
    <div className="log-panel">
      <div className="log-header">
        <strong>📋 Лог подій</strong>
        <div>
          <button onClick={onCopy}>Копіювати</button>
          <button onClick={onClear} style={{ background: '#666', marginLeft: '10px' }}>
            Очистити
          </button>
        </div>
      </div>
      <pre>{logText}</pre>
    </div>
  );
};

// ------------------ RULES MODAL ------------------
const RulesModal = ({ onClose }) => {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
        <h2>📜 Правила Гри</h2>
        <div style={{ textAlign: 'left', marginTop: '15px', lineHeight: '1.6' }}>
          <p><strong>1. Мета гри:</strong> Зібрати всі 4 стихії (🔥💧🌍💨) в одній фігурі.</p>
          <p><strong>2. Як ходити:</strong> Фігури ходять як кінь у шахах (буквою «Г»).</p>
          <p><strong>3. Злиття:</strong> При стрибку на іншу фігуру їхні стихії об'єднуються.</p>
          <p><strong>4. Перемога:</strong> Перемагає той, хто першим створить Квінтесенцію (всі 4 стихії разом).</p>
        </div>
        <button className="action-btn" style={{marginTop: '25px', width: '100%'}} onClick={onClose}>Зрозуміло</button>
      </div>
    </div>
  );
};

// ------------------ ГОЛОВНИЙ КОМПОНЕНТ ------------------
function App() {
  const [boardSize, setBoardSize] = useState(4);
  const {
    board,
    currentPlayer,
    winner,
    moveCount,
    nodes,
    error,
    engine,
    makeMove,
    resetGame,
    getAIMove,
    refresh,
  } = useEngine(boardSize);

  const [gameMode, setGameMode] = useState('vsAI');
  const [aiDifficulty, setAiDifficulty] = useState('medium');
  const [firstPlayer, setFirstPlayer] = useState(0);
  const [selected, setSelected] = useState(null);
  const [validMoves, setValidMoves] = useState([]);
  const [aiThinking, setAiThinking] = useState(false);
  const [logText, setLogText] = useState('');
  const [hint, setHint] = useState(null);
  const [showRules, setShowRules] = useState(false);

  const isThinkingRef = useRef(false);

  const handleUndo = useCallback(() => {
    if (engine.history.length === 0) return;
    
    if (gameMode === 'vsAI' && engine.history.length >= 2 && currentPlayer === 0) {
      engine.undo();
      engine.undo();
    } else {
      engine.undo();
    }
    refresh();
    setSelected(null);
    setValidMoves([]);
  }, [engine, refresh, gameMode, currentPlayer]);

  const getHint = useCallback(() => {
    if (isThinkingRef.current) return;
    const bestMove = getAIMove(aiDifficulty);
    if (bestMove) {
      setHint(bestMove);
      setTimeout(() => setHint(null), 3000);
    }
  }, [getAIMove, aiDifficulty]);

  useEffect(() => {
    setLogText(logger.getText());
  }, [moveCount, winner, error, aiThinking]);

  const handleCellClick = useCallback(
    (r, c) => {
      if (winner !== null) return;
      if (gameMode === 'vsAI' && currentPlayer === 1) return;

      const piece = board[r][c];

      if (!selected) {
        if (piece.length > 0) {
          setSelected({ r, c });
          setValidMoves(engine.targets[r][c]);
        }
        return;
      }

      if (selected.r === r && selected.c === c) {
        setSelected(null);
        setValidMoves([]);
        return;
      }

      const isValid = validMoves.some(([nr, nc]) => nr === r && nc === c);
      if (!isValid) {
        if (piece.length > 0) {
          setSelected({ r, c });
          setValidMoves(engine.targets[r][c]);
        } else {
          setSelected(null);
          setValidMoves([]);
        }
        return;
      }

      makeMove(selected.r, selected.c, r, c);
      setSelected(null);
      setValidMoves([]);
    },
    [board, selected, validMoves, winner, gameMode, currentPlayer, makeMove, engine.targets]
  );

  const onDragStart = (e, r, c) => {
    if (gameMode === 'vsAI' && currentPlayer === 1) return;
    e.dataTransfer.setData('pos', JSON.stringify({ r, c }));
    setSelected({ r, c });
    setValidMoves(engine.targets[r][c]);
  };

  const onDragOver = (e) => e.preventDefault();

  const onDrop = (e, tr, tc) => {
    e.preventDefault();
    const posData = e.dataTransfer.getData('pos');
    if (!posData) return;
    const { r: fr, c: fc } = JSON.parse(posData);
    
    const isValid = engine.targets[fr][fc].some(([nr, nc]) => nr === tr && nc === tc);
    if (isValid) {
      makeMove(fr, fc, tr, tc);
    }
    setSelected(null);
    setValidMoves([]);
  };

  useEffect(() => {
    // Якщо не режим AI, або гра закінчена, або не черга AI – виходимо
    if (gameMode !== 'vsAI') return;
    if (winner !== null) return;
    if (currentPlayer !== 1) return;

    // Якщо AI вже думає – не запускаємо повторно
    if (isThinkingRef.current) {
      console.log('AI вже думає (ref)');
      return;
    }

    console.log('AI починає думати');
    isThinkingRef.current = true;
    setAiThinking(true);

    const timer = setTimeout(() => {
      try {
        console.log('Викликаємо getAIMove з рівнем', aiDifficulty);
        const move = getAIMove(aiDifficulty);
        console.log('getAIMove повернув', move);
        if (move) {
          makeMove(...move.from, ...move.to);
        } else {
          logger.add('AI', 'Не вдалося знайти хід (move = null)');
        }
      } catch (e) {
        logger.add('ERROR', `Помилка в AI: ${e.message}`);
        console.error(e);
      } finally {
        isThinkingRef.current = false;
        setAiThinking(false);
        setSelected(null);
        setValidMoves([]);
        console.log('AI закінчив');
      }
    }, 50);

    return () => {
      clearTimeout(timer);
      // Якщо таймер очищено, то AI не виконає хід, тому скидаємо ref
      isThinkingRef.current = false;
      setAiThinking(false);
    };
  }, [currentPlayer, winner, gameMode, aiDifficulty, getAIMove, makeMove]);

  const handleReset = useCallback(() => {
    resetGame(gameMode === 'vsAI' ? firstPlayer : 0);
    setSelected(null);
    setValidMoves([]);
    setAiThinking(false);
    isThinkingRef.current = false;
  }, [resetGame, gameMode, firstPlayer]);

  const handleSetGameMode = useCallback(
    (mode) => {
      setGameMode(mode);
      setTimeout(() => handleReset(), 0);
    },
    [handleReset]
  );

  const handleSetFirstPlayer = useCallback(
    (player) => {
      setFirstPlayer(player);
      resetGame(player);
      setSelected(null);
      setValidMoves([]);
    },
    [resetGame]
  );

  const handleSetBoardSize = useCallback((size) => {
    setBoardSize(size);
    // useEngine hook will automatically create a new engine, but we should reset state
    setSelected(null);
    setValidMoves([]);
    setAiThinking(false);
    isThinkingRef.current = false;
  }, []);

  const elementCounts = { '🔥': 0, '💧': 0, '🌍': 0, '💨': 0 };
  const currentSize = board.length;
  for (let r = 0; r < currentSize; r++) {
    for (let c = 0; c < currentSize; c++) {
      board[r][c].forEach((e) => elementCounts[e]++);
    }
  }

  const copyLog = useCallback(() => {
    navigator.clipboard.writeText(logger.getText()).then(() => alert('Лог скопійовано'));
  }, []);

  const clearLog = useCallback(() => {
    logger.clear();
    setLogText('');
  }, []);

  return (
    <div className="aether-game">
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
      
      <h1>⚡ AETHER PROFESSIONAL ⚡</h1>
      <div className="subtitle">Стабільний двигун з класичним дизайном</div>

      {error && <div className="error-message" style={{ color: 'red', marginBottom: '10px' }}>⚠️ Помилка: {error}</div>}

      <div className="game-layout">
        {/* Left Side: Game Board */}
        <div className="board-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="action-buttons" style={{ display: 'flex', justifyContent: 'center', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
            <button className="action-btn" onClick={() => setShowRules(true)}>ℹ️ Правила</button>
            <button className="action-btn" onClick={handleUndo} disabled={engine.history.length === 0}>🔙 Відміна</button>
            <button className="action-btn" onClick={getHint} disabled={winner !== null || aiThinking}>💡 Підказка</button>
          </div>

          <Board
            board={board}
            selected={selected}
            validMoves={validMoves}
            hint={hint}
            onCellClick={handleCellClick}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
          />

          {aiThinking && <div className="thinking">🤖 ШІ {aiDifficulty} аналізує...</div>}
          {hint && (
            <div className="hint-indicator" style={{ textAlign: 'center', color: '#eab308', fontWeight: 'bold', marginTop: '15px' }}>
              💡 Порада: ({hint.from[0]},{hint.from[1]}) → ({hint.to[0]},{hint.to[1]})
            </div>
          )}
        </div>

        {/* Right Side: Control Panels */}
        <div className="side-panel">
          <ControlPanel
            gameMode={gameMode}
            setGameMode={handleSetGameMode}
            aiDifficulty={aiDifficulty}
            setAiDifficulty={setAiDifficulty}
            firstPlayer={firstPlayer}
            setFirstPlayer={handleSetFirstPlayer}
            boardSize={boardSize}
            setBoardSize={handleSetBoardSize}
            onReset={handleReset}
            winner={winner}
            currentPlayer={currentPlayer}
            moveCount={moveCount}
          />

          <StatsPanel
            elementCounts={elementCounts}
            gameMode={gameMode}
            aiDifficulty={aiDifficulty}
            nodes={nodes}
          />

          <LogPanel logText={logText} onCopy={copyLog} onClear={clearLog} />
        </div>
      </div>
    </div>
  );
}

export default App;