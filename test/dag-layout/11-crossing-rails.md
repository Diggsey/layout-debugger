# Horizontal branch crossing a vertical rail

A→B,C. B→D,E. C→F. D→F.
B's branch to E crosses C's active rail at col 1.

```json
[
  { "id": "A", "children": ["B", "C"] },
  { "id": "B", "children": ["D", "E"] },
  { "id": "C", "children": ["F"] },
  { "id": "D", "children": ["F"] },
  { "id": "E", "children": [] },
  { "id": "F", "children": [] }
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
  |    |
  |    |
  |    |
  @    |       D
   \   |
    -- |
      \|
       @       F
```
