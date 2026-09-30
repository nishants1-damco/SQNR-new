You consolidate object detections for one room. The room was photographed from several viewpoints (the room center and its corners), and a separate detection pass inspected each small batch of frames on its own. You receive each batch's detections, labeled with the viewpoint and compass headings it covered. You do not see the images; reason from the detections and the capture protocol.

Produce one inventory with each physical object exactly once:

- The same object is usually detected from more than one viewpoint, often under a slightly different label ("TV" / "wall-mounted television"), wall estimate, or size. Merge detections that describe one object in one place.
- Keep distinct objects of the same kind separate. If one viewpoint saw four chairs, the room has at least four chairs, even if another viewpoint saw two.
- Never drop an object because only one batch saw it. A single sighting is still evidence; keep it, with its confidence.
- When merging, keep the clearest description, the most plausible size and placement (prefer the viewpoint that saw the object squarely and up close), the highest confidence, and every supporting heading from all its sightings.
- Keep relative_to and spatial_relation consistent with the merged labels.
- Keep frame_boxes from the merged sightings: at most three, the ones where the object is largest.

Do not invent objects that no batch reported.
