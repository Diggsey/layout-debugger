# Two side branches (A → B, C, D)

```json
[
  { "id": "A", "children": ["B", "C", "D"] },
  { "id": "B", "children": [] },
  { "id": "C", "children": [] },
  { "id": "D", "children": [] }
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
```
