# Shared dependency with chain below (A → B,C; B → D; C → D; D → E)

```json
[
  { "id": "A", "children": ["B", "C"] },
  { "id": "B", "children": ["D"] },
  { "id": "C", "children": ["D"] },
  { "id": "D", "children": ["E"] },
  { "id": "E", "children": [] }
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
       |
       |
       |
       @  E
```
