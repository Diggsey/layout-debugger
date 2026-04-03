# Avoiding horizontal overlap via column allocation

A→B,C. B→D,E. C→D. The allocator places E at col 2 (beyond C's rail)
so that B's branch and the merge into D don't overlap.

```json
[
  { "id": "A", "children": ["B", "C"] },
  { "id": "B", "children": ["D", "E"] },
  { "id": "C", "children": ["D"] },
  { "id": "D", "children": [] },
  { "id": "E", "children": [] }
]
```

```text
  @            A
  |\
  | --
  |   \
  |    @       C
  |    |
  |    |
  |    |
  @    |       B
  |\   |
  | -------
  |    |   \
  |    |    @  E
   \   |
    -- |
      \|
       @       D
```
