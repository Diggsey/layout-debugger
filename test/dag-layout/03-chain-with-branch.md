# Chain with branch (A → B → D, A → C)

```json
[
  { "id": "A", "children": ["B", "C"] },
  { "id": "B", "children": ["D"] },
  { "id": "C", "children": [] },
  { "id": "D", "children": [] }
]
```

```text
  @       A
  |\
  | --
  |   \
  |    @  C
  |
  |
  |
  @       B
  |
  |
  |
  @       D
```
