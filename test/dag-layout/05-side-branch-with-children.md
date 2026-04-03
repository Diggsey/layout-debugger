# Side branch with children (A → B, A → C → D)

```json
[
  { "id": "A", "children": ["B", "C"] },
  { "id": "B", "children": [] },
  { "id": "C", "children": ["D"] },
  { "id": "D", "children": [] }
]
```

```text
  @       A
  |\
  | --
  |   \
  |    @  C
  |    |
  |    |
  |    |
  |    @  D
  |
  |
  |
  @       B
```
