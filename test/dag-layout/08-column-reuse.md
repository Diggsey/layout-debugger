# Branch with column reuse

```json
[
  { "id": "A", "children": ["B", "C", "D"] },
  { "id": "B", "children": ["E", "F"] },
  { "id": "C", "children": [] },
  { "id": "D", "children": [] },
  { "id": "E", "children": [] },
  { "id": "F", "children": [] }
]
```

```text
  @            A
  |\
  | -------
  |   \    \
  |    |    @  D
  |    |
  |    |
  |    |
  |    @       C
  |
  |
  |
  @            B
  |\
  | --
  |   \
  |    @       F
  |
  |
  |
  @            E
```
