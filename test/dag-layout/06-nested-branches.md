# Nested branches (A → B → D, A → C, B → E)

```json
[
  { "id": "A", "children": ["B", "C"] },
  { "id": "B", "children": ["D", "E"] },
  { "id": "C", "children": [] },
  { "id": "D", "children": [] },
  { "id": "E", "children": [] }
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
  |\
  | --
  |   \
  |    @  E
  |
  |
  |
  @       D
```
