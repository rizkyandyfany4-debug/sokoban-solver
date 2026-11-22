# Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/rizkyandyfany4-debug/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/rizkyandyfany4-debug/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's
[Build the best Sokoban solver](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty. One run answers a whole set of 5 levels in as few pushes as
possible.

## How it works

Every level the generator draws is a 1-wide hallway with 1–4 rooms off
it (6×6 slots, one door each, 3–4 boxes and as many goals per room). A
box pushed through a door into the hallway can never come back, so every
box stays in its own room and the level's push-optimal count P\* is the
sum of the rooms' optima. The solver therefore:

1. cuts the level into rooms (the hallway row's dead squares — squares
   from which no box can ever be pulled onto a goal — split the board
   into its rooms),
2. solves each room push-optimally on its own, with the other rooms'
   boxes standing as walls, and
3. stitches the room solutions together (the player just walks on from
   where the last room left it; the generator picks each room's goals so
   finishing a room never shuts the player in).

Each room is solved by an A\* over pushes: a state is the boxes'
squares plus the player's reachable region (named by its lowest
square). The estimate is the cheapest box-to-goal matching over
shortest-path distances, which is admissible — every push moves one
box one square — so the first solved state found is push-optimal.
Deadlocks are pruned two ways: dead squares (a box that can never be
pulled onto any goal) and frozen 2×2 blocks. If a room's A\* gives up,
the same search runs again as plain breadth-first search, and if the
level is no set of rooms at all the search runs over the whole level.
Everything is budgeted by work (state expansions), never by the clock,
so two runs write the same bytes.

## How to run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/level.txt` for `i001`–`i005` (or
`$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` for each,
creating the directories itself. Node 22, no dependencies, no network.

<sub>Entered on [make.fun](https://make.fun/?ref=0adx9fja&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
