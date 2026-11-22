// sokoban-solver: a push-optimal Sokoban solver for make.fun's
// sokoban-solver-01-run-20261121 ("Build the best Sokoban solver").
//
// How it works
// ------------
// Every level the generator draws is a 1-wide hallway with 1-4 rooms off
// it (6x6 slots, one door each, 3-4 boxes and as many goals per room).
// A box pushed through a door into the hallway can never come back, so
// every box stays in its own room and the level's push-optimal count P*
// is the sum of the rooms' optima. This solver therefore:
//
//   1. cuts the level into rooms (the hallway row's dead squares —
//      squares from which no box can ever be pulled onto a goal —
//      split the board into its rooms),
//   2. solves each room push-optimally on its own, with the other rooms'
//      boxes standing as walls, and
//   3. stitches the room solutions together (the player just walks on
//      from where the last room left it; the generator picks each room's
//      goals so finishing a room never shuts the player in).
//
// Each room is solved by an A* over pushes: a state is the boxes'
// squares plus the player's reachable region (named by its lowest
// square). The estimate is the cheapest box-to-goal matching over
// shortest-path distances (admissible: every push moves one box one
// square), so the first solved state found is push-optimal. Deadlocks
// are pruned two ways: dead squares (a box that can never be pulled
// onto any goal) and frozen 2x2 blocks. If a room's A* gives up, the
// same search runs again as plain breadth-first search (estimate 0),
// and if the level is no set of rooms at all the search runs over the
// whole level. Everything is budgeted by work (state expansions),
// never by the clock, so two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input \
//   MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four steps: [dx, dy, letter]. */
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

/** Work budgets, in state expansions — never the clock. */
const ROOM_ASTAR_CAP = 400_000;
const ROOM_BFS_CAP = 250_000;
const LEVEL_CAP = 300_000;
const GLOBAL_CAP = 8_000_000;
let spent = 0;

/** A level in XSB: width, height, walls (1 a wall), goals, boxes, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pulled onto some goal. */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const { dx, dy } of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= wall.length || behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway) out of the floor, and each part left that holds a box is a
 * room. Null when the level is no set of rooms (a box in the hallway,
 * a goal outside every part, or a part whose boxes and goals differ).
 */
function decompose(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (const { dx, dy } of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Walking distances from `from` over open floor (walls only). */
function bfsDist(level, from) {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (const { dx, dy } of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** The shortest walk from `from` to `to` around walls and boxes, or null. */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const { dx, dy, ch } of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` from `from`. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of `level` in at most `cap` expansions:
 * {pushes, moves}, or null when the search gives up. With `astar` the
 * estimate is the cheapest box-to-goal matching over shortest-path
 * distances; without it the estimate is 0 (plain breadth-first search
 * over pushes). Either way the first solved state found is optimal.
 */
function pushSearch(level, cap, astar) {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = level;
  const size = wall.length;
  const n = startBoxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (startBoxes.some((b) => !live[b])) return null;
  const solved = (bs) => bs.every((b) => goal[b]);
  if (solved(startBoxes)) return { pushes: 0, moves: '' };

  // Distances from each goal over open floor, for the estimate.
  const distFrom = goals.map((g) => bfsDist(level, g));
  const estimate = (bs) => {
    if (!astar) return 0;
    if (n <= 4) {
      // Cheapest box-to-goal matching, by trying every assignment.
      let best = Infinity;
      const rec = (i, used, cost) => {
        if (cost >= best) return;
        if (i === n) {
          if (cost < best) best = cost;
          return;
        }
        for (let j = 0; j < n; j++) {
          if (used & (1 << j)) continue;
          const d = distFrom[j][bs[i]];
          if (d < 0) continue;
          rec(i + 1, used | (1 << j), cost + d);
        }
      };
      rec(0, 0, 0);
      return best;
    }
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (let j = 0; j < n; j++) {
        const d = distFrom[j][b];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  // Reachable region from `from` with `occupied` in the way, in `arr`
  // under a fresh stamp; returns [lowest square, stamp]. Two arrays:
  // `seen` holds the state being expanded, `mark` the states a push
  // makes — one array would let a successor's region overwrite the
  // region the expansion is still testing pushes against.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const reach = (occupied, from, arr) => {
    const st = ++stamp;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    arr[from] = st;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      for (const { dx, dy } of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= size) continue;
        if (!wall[q] && !occupied[q] && arr[q] !== st) {
          arr[q] = st;
          stack[sp++] = q;
        }
      }
    }
    return [low, st];
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block of
  // walls and boxes with a box off its goal.
  const frozenBlock = (occupied, t) => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (a < 0 || d >= size) continue;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
    }
    return false;
  };

  // A state's key: its region's lowest square and the boxes' squares.
  // Numeric while size ** (n + 1) stays under 2 ** 53, a string otherwise.
  const numeric = size ** (n + 1) < 2 ** 53;
  const keyOf = (bs, low) => {
    if (numeric) {
      let k = low;
      for (const b of bs) k = k * size + b;
      return k;
    }
    return `${low}:${bs.join(',')}`;
  };

  // The heap, ordered by f, then deeper first, then found first.
  const heap = [];
  const cmp = (a, b) => a[0] - b[0] || b[1] - a[1] || a[2] - b[2];
  const heapPush = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(heap[i], heap[p]) >= 0) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && cmp(heap[c + 1], heap[c]) < 0) c++;
        if (cmp(heap[c], heap[i]) >= 0) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };

  const occupied = new Uint8Array(size);
  for (const b of startBoxes) occupied[b] = 1;
  const sBoxes = [startBoxes.slice()];
  const sPlayer = [startPlayer];
  const sG = [0];
  const sParent = [-1];
  const sPush = [-1]; // the push that made the state: box square * 4 + direction
  const sKey = [keyOf(startBoxes, reach(occupied, startPlayer, seen)[0])];
  const h0 = estimate(startBoxes);
  if (h0 === Infinity) return null;
  const best = new Map([[sKey[0], 0]]);
  const closed = new Set();
  heapPush([h0, 0, 0]);
  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, g, s] = heapPop();
    if (closed.has(sKey[s])) continue;
    closed.add(sKey[s]);
    expanded++;
    spent++;
    if (expanded > cap || spent >= GLOBAL_CAP) return null;
    const bs = sBoxes[s];
    if (solved(bs)) {
      found = s;
      break;
    }
    for (const b of bs) occupied[b] = 1;
    const [, region] = reach(occupied, sPlayer[s], seen);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi];
      for (let di = 0; di < 4; di++) {
        const { dx, dy } = DIRS[di];
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        if (seen[b - d] !== region || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(occupied, t);
        let key = null;
        let next = null;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(occupied, b, mark)[0]);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || key === null) continue;
        if (closed.has(key)) continue;
        const known = best.get(key);
        if (known !== undefined && known <= g + 1) continue;
        const h = estimate(next);
        if (h === Infinity) continue;
        best.set(key, g + 1);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sG.push(g + 1);
        sParent.push(s);
        sPush.push(b * 4 + di);
        sKey.push(key);
        heapPush([g + 1 + h, g + 1, idx]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The path of pushes, then the moves: walk to each push's square, push.
  const path = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes.slice();
  for (const s of path) {
    const code = sPush[s];
    const from = Math.floor(code / 4);
    const di = code % 4;
    const { dx, dy, ch } = DIRS[di];
    const d = dy * w + dx;
    const occ = new Uint8Array(size);
    for (const b of boxes) occ[b] = 1;
    const walk = walkTo(level, occ, player, from - d);
    if (walk === null) return null;
    moves += walk + ch;
    player = from;
    boxes = sBoxes[s].slice();
  }
  return { pushes: path.length, moves };
}

/** The level's solution: room by room, or the whole level as a fallback. */
function solveLevel(text) {
  const level = parseLevel(text);
  const rooms = decompose(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      let res = pushSearch(sub, ROOM_ASTAR_CAP, true);
      if (res === null) res = pushSearch(sub, ROOM_BFS_CAP, false);
      if (res === null) {
        ok = false;
        break;
      }
      moves += res.moves;
      player = endOf(level.w, player, res.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  const whole = pushSearch(level, LEVEL_CAP, true) ?? pushSearch(level, LEVEL_CAP, false);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
