# png-squeeze-01 — entry 1

Lossless screenshot squeezer for make.fun quest `png-squeeze-01-run-20261127`.

## How it works

- Decodes each 1280×720 RGBA screenshot and picks the tightest lossless form:
  palette (≤256 colours, count-order and luminance-order), grey / grey+alpha,
  transparent-key `tRNS`, RGB, or RGBA.
- Chooses each row's PNG filter (fixed 0/1/2/4, minimum-sum, fewest-pairs)
  by a zlib level-6 screen.
- Compresses the winning filtered stream with a hand-rolled optimal-parse
  DEFLATE encoder: a greedy pass seeds Huffman costs, a shortest-path parse
  picks every literal and match (hash-chain knees, best distance per length
  boundary), and one dynamic-Huffman block is emitted. A zlib level-9 stream
  is also built and the smaller of the two is kept.
- Deterministic: fixed work per image, no clock, no environment input.

## Practice set (kit scorer)

- Score **723,584** — passed 1, answered 8/8, every instance exact.
- Per-instance points: i001 726, i002 727, i003 694, i004 709, i005 776,
  i006 707, i007 712, i008 738.
- Runtime ≈ 42–46 s wall locally for the full set (grader wall 60 s).

## Entry

- Program: `node /bot/main.ts` (Node 22, no network).
- `main.ts` — the whole program; `LICENSE` — MIT.
