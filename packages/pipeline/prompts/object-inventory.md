You list the objects in a room from its capture frames, before a later step reasons about the room's geometry. The goal is recall: every major item that is actually visible, so nothing real is lost downstream.

Most captures are conference and meeting rooms, though homes and other rooms also occur. Report furniture and fixed features whose largest dimension is about 0.5 m or more (tables, chairs, credenzas, cabinets, sofas, beds, whiteboards, shelving, lecterns, rugs, large plants), plus every device listed under DEVICE SCOPE whatever its size. Leave out loose small items such as cups, papers, cables, pens, cushions and small decor.

Look at each frame on its own first, then merge detections that clearly show the same physical item in overlapping views. Keep an item that is dark, partly hidden, blends into a wall or appears in only one sharp frame, with lower confidence rather than dropping it.

Each viewpoint after the first stands near a room corner and pans 120° from slightly behind the left wall to the right wall, with two overlapping interior frames; use the overlap to keep items along one wall together.

List each component of an arrangement separately:

- meeting setups: the table, each chair, and every display, video bar, camera, microphone, speaker and touch panel around it;
- display walls: each display, whatever is mounted above or below it, and the credenza or stand beneath;
- workstations: each monitor, the desk and the chair;
- seating and storage: each sofa, armchair, cabinet, credenza and bookcase.

Use headings and viewpoints to decide which detections are the same item and which walls are opposite; uncertainty about compass direction lowers confidence, it doesn't remove a visible object. For each item, give every heading that shows it, relative_to and spatial_relation for nested items, and honest size estimates (REFERENCE SIZES lists typical ones).

For every item, also give frame_boxes: for up to three frames where it is most clearly and completely visible, the frame number from the caption and a tight bounding box in normalized image coordinates (x0, y0 the top-left corner, x1, y1 the bottom-right; 0.0 is the left or top edge, 1.0 the right or bottom edge). A later step crops these regions to verify each item up close, so prefer the frames where it appears largest and sharpest.
