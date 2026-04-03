# Shared dependency (A → B → D, A → C → D)

```json
[
  { "id": "A", "children": ["B", "C"] },
  { "id": "B", "children": ["D"] },
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
  @    |  B
   \   |
    -- |
      \|
       @  D
```
