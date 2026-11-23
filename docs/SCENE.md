# The scene file

A Parter plan is one JSON document. The editor, the assistant, the MCP server and the exports
all work on it. `normalizeScene()` in `public/js/core/scene.js` validates and repairs anything
loaded, so a hand-edited file with a mistake loads with that part dropped instead of failing.

Units are metres. `x` runs east, `y` runs north.

```jsonc
{
  "format": "parter-scene",
  "version": 1,
  "name": "My flat",
  "ceiling": 2.7,                      // ceiling height for the whole floor

  "walls": [
    {
      "id": "w1",
      "x0": 0, "y0": 0, "x1": 10.3, "y1": 0.4,   // a rectangle on the plan
      "v": 1,                                     // optional: divider only, not built in 3D
      "ops": [                                    // openings cut into this wall
        {
          "id": "o1",
          "k": "win",                 // win | door | open (no leaf) | garage
          "a": 0.75, "b": 2.85,       // start and end along the wall's long axis, world coordinates
          "sill": 0.9, "head": 2.2,   // bottom and top above the floor
          "st": "closed",             // doors: open | closed | wall (bricked up). Optional.
          "h": "b", "s": 1,           // doors: hinge end (a|b) and swing side (1|-1)
          "gl": 1                     // doors: glazed
        }
      ]
    }
  ],

  "rooms": [                           // labels, not shapes: a point inside a room
    { "id": "r1", "name": "Living room", "x": 3.2, "y": 5.0,
      "floor": "tile",                 // tile | wood | bath | conc
      "say": "open-plan living room of about 51 m²" }   // optional phrase for prompts
  ],

  "items": [                           // furniture
    { "id": "i1", "t": "sofa3",        // type: a key of CAT in core/catalog.js
      "x": 2.4, "y": 4.9,              // centre
      "r": 90,                         // degrees counter-clockwise; 0 = back to the north
      "w": 2.2, "d": 0.95,             // width along the back, depth back to front
      "h": 0.8,                        // optional height override
      "f": 0 }                         // 1 = mirrored left to right
  ],

  "cam": { "x": 5.9, "y": 8.9, "yaw": -2.24, "pitch": -0.07, "h": 1.5, "fov": 66 },
                                       // yaw in radians, 0 = east; fov is the vertical angle

  "steps": [ { "x0": 4.9, "x1": 7, "y": 0, "dir": -1 } ],   // outside steps, optional
  "underlay": { "x": -1, "y": -1, "w": 14, "h": 10, "opacity": 0.5, "show": true },
                                       // where the scanned plan sits; the picture itself is stored separately
  "meta": { "created": 0, "modified": 0, "source": "free text" }
}
```

## Rooms are derived

There is no room geometry in the file. `analyze()` in `core/rooms.js` rasterises the walls on
a 5 cm grid, floods in from outside, and every enclosed pocket is a room. A room takes its
name and floor from the label that sits inside it. Consequences:

- Walls must touch or overlap at corners, or rooms leak into each other or into the outside.
- Doorways still separate rooms, because an opening lives inside its wall.
- To split an open space into two named rooms without building anything, add a wall with
  `"v": 1`.
- Whether a door is "exterior" (and so closed by default) is derived too.

## Wall axis

A wall runs along whichever side is longer. Its openings are measured along that axis. If you
resize a wall so that it becomes wider than it is long, its openings are dropped.

## Pictures

The scanned plan and generated renders are not in the scene file. In the browser they live in
IndexedDB under `<project>:underlay` and `<project>:render:<time>`; in local mode they are
image files in `projects/.blobs/`.
