# pet-images

Photos for `e2e/98-pets-real-model.spec.js`, downscaled to at most 1024 px,
re-encoded with no EXIF or GPS.

| File | What | Source | License |
| --- | --- | --- | --- |
| `mimi_01.jpg` … `mimi_04.jpg` | Mimi, a ragdoll cat | The repository author's own photos, given for these tests | The author's |
| `larry_01.jpg` | Larry, the Downing Street cat | [Larry at No. 10, waiting for Mike Pompeo](https://commons.wikimedia.org/?curid=86469455), U.S. Embassy in U.K. | Public domain |
| `bo_01.jpg` | Bo, a Portuguese water dog | [Bo Obama March 2010 (a)](https://commons.wikimedia.org/?curid=67241066), The White House | Public domain |
| `bo_02.jpg` | Bo | [Bo Obama March 2010](https://commons.wikimedia.org/?curid=14934844), The White House | Public domain |

Chosen so the result has room to spare at the pet threshold (0.58, cosine of
DINOv2 Small body embeddings): the four Mimi photos are 0.69 or more apart from
each other, the two Bo photos 0.96, and Larry no more than 0.27 from any Mimi
photo. Swap one only after checking that again with the real people-worker.
