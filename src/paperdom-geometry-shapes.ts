// Forked from ferax564/paperDOM@a12198c app/geometry-shapes.ts (MIT). Maintained in this repository; see src/paperdom-pin.ts.
// OOXML preset geometry (prstGeom) names map to PowerPoint's shape gallery.
// Each entry stores an SVG path drawn on a 100x100 box; renderers stretch it to
// the element frame via preserveAspectRatio="none", matching preset geometry
// semantics (the shape scales to its bounding box).
export const SHAPE_GEOMETRIES = {
  triangle: {
    label: 'Triangle',
    path: 'M50 0 L100 100 L0 100 Z',
  },
  rtTriangle: {
    label: 'Right triangle',
    path: 'M0 0 L100 100 L0 100 Z',
  },
  diamond: {
    label: 'Diamond',
    path: 'M50 0 L100 50 L50 100 L0 50 Z',
  },
  pentagon: {
    label: 'Pentagon',
    path: 'M50 0 L100 38 L81 100 L19 100 L0 38 Z',
  },
  hexagon: {
    label: 'Hexagon',
    path: 'M25 0 L75 0 L100 50 L75 100 L25 100 L0 50 Z',
  },
  octagon: {
    label: 'Octagon',
    path: 'M30 0 L70 0 L100 30 L100 70 L70 100 L30 100 L0 70 L0 30 Z',
  },
  parallelogram: {
    label: 'Parallelogram',
    path: 'M25 0 L100 0 L75 100 L0 100 Z',
  },
  trapezoid: {
    label: 'Trapezoid',
    path: 'M20 0 L80 0 L100 100 L0 100 Z',
  },
  star4: {
    label: '4-point star',
    path: 'M50 0 L61 39 L100 50 L61 61 L50 100 L39 61 L0 50 L39 39 Z',
  },
  star5: {
    label: '5-point star',
    path: 'M50 0 L61 35 L98 35 L68 57 L79 91 L50 70 L21 91 L32 57 L2 35 L39 35 Z',
  },
  star6: {
    label: '6-point star',
    path: 'M50 0 L63 28 L94 25 L72 50 L94 75 L63 72 L50 100 L37 72 L6 75 L28 50 L6 25 L37 28 Z',
  },
  rightArrow: {
    label: 'Right arrow',
    path: 'M0 25 L60 25 L60 0 L100 50 L60 100 L60 75 L0 75 Z',
  },
  leftArrow: {
    label: 'Left arrow',
    path: 'M100 25 L40 25 L40 0 L0 50 L40 100 L40 75 L100 75 Z',
  },
  upArrow: {
    label: 'Up arrow',
    path: 'M25 100 L25 40 L0 40 L50 0 L100 40 L75 40 L75 100 Z',
  },
  downArrow: {
    label: 'Down arrow',
    path: 'M25 0 L25 60 L0 60 L50 100 L100 60 L75 60 L75 0 Z',
  },
  leftRightArrow: {
    label: 'Left-right arrow',
    path: 'M0 50 L20 20 L20 40 L80 40 L80 20 L100 50 L80 80 L80 60 L20 60 L20 80 Z',
  },
  chevron: {
    label: 'Chevron',
    path: 'M0 0 L60 0 L100 50 L60 100 L0 100 L40 50 Z',
  },
  homePlate: {
    label: 'Home plate',
    path: 'M0 0 L70 0 L100 50 L70 100 L0 100 Z',
  },
  plus: {
    label: 'Plus',
    path: 'M35 0 L65 0 L65 35 L100 35 L100 65 L65 65 L65 100 L35 100 L35 65 L0 65 L0 35 L35 35 Z',
  },
  heart: {
    label: 'Heart',
    path: 'M50 88 C8 55 2 25 22 10 C37 0 50 8 50 28 C50 8 63 0 78 10 C98 25 92 55 50 88 Z',
  },
  moon: {
    label: 'Moon',
    path: 'M62 0 A50 50 0 1 0 62 100 A40 50 0 1 1 62 0 Z',
  },
  lightningBolt: {
    label: 'Lightning bolt',
    path: 'M58 0 L18 58 L44 58 L38 100 L84 38 L56 38 Z',
  },
  cloud: {
    label: 'Cloud',
    path: 'M25 75 A16 16 0 0 1 22 44 A20 20 0 0 1 38 22 A22 22 0 0 1 75 30 A16 16 0 0 1 88 55 A13 13 0 0 1 78 75 Z',
  },
  wedgeRectCallout: {
    label: 'Speech bubble',
    path: 'M0 0 L100 0 L100 62 L58 62 L70 100 L42 62 L0 62 Z',
  },
  donut: {
    label: 'Donut',
    path: 'M50 0 A50 50 0 1 0 50 100 A50 50 0 1 0 50 0 Z M50 22 A28 28 0 1 0 50 78 A28 28 0 1 0 50 22 Z',
    fillRule: 'evenodd' as const,
  },
} as const;

export type ShapeGeometry = keyof typeof SHAPE_GEOMETRIES;

export const shapeGeometryLabel = (geometry?: string) =>
  geometry && geometry in SHAPE_GEOMETRIES ? SHAPE_GEOMETRIES[geometry as ShapeGeometry].label : undefined;

export const shapeGeometryPath = (geometry?: string) =>
  geometry && geometry in SHAPE_GEOMETRIES ? SHAPE_GEOMETRIES[geometry as ShapeGeometry] : undefined;
