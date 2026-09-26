// Line-art hands, authored by hand as SVG paths. Units are roughly millimetres.
// Every pose puts its contact point (fingertip, knuckle, pinch point or palm centre) at the origin,
// with the arm entering from +y. A right hand seen from above (back of the hand): the thumb is on the left.
// `outline` is the silhouette (filled with the background so it hides the drawing beneath),
// `details` are the few interior lines that make it read as a hand: nails, creases, tendons.

export type Pose = 'point' | 'knuckle' | 'flat' | 'pinch' | 'pinchOpen' | 'side'

export interface HandArt {
  outline: string
  details: string[]
  /** Faint lines (tendons), drawn at lower opacity. */
  faint?: string[]
}

const point: HandArt = {
  outline: [
    'M -12 150',
    'C -13 138 -15.5 128 -18.5 118', // heel of the thumb
    'C -22.5 106 -27 96 -28 88',
    'C -28.8 82 -26.4 77.6 -22.2 78', // thumb tip
    'C -18.6 78.4 -14.6 83.4 -11.6 89',
    'C -10.2 90.6 -9.2 88 -8.9 84', // web
    'C -8.6 60 -8.4 34 -8 11',
    'C -7.8 4.4 -4.4 0 0 0', // index tip
    'C 4.4 0 7.6 4.4 7.6 11',
    'C 7.8 30 8 46 8.4 61',
    'C 10.6 57.2 16.4 56.6 19.6 60.4', // middle knuckle, curled
    'C 22.8 57.2 28.6 57.8 30.8 62.2', // ring
    'C 33.8 60.6 38.6 62.2 40 67.2', // little finger
    'C 43.6 70 45.4 76 45.4 84',
    'C 45.4 99 43 114 39.4 126',
    'C 37 135 35.4 143 34.6 150'
  ].join(' '),
  details: [
    'M -4.3 12.4 C -4.3 6.4 4.1 6.4 4.1 12.4', // nail
    'M -4.3 12.4 C -1.8 13.8 1.6 13.8 4.1 12.4',
    'M -3.8 33 C -1.4 34.3 1.4 34.3 3.6 33', // index creases
    'M -4.2 49.6 C -1.4 51.2 1.4 51.2 4.1 49.6',
    'M 8.4 61 C 8.9 67 9.4 71 10.2 75', // index against the curled fingers
    'M 19.6 60.4 C 19.8 66 19.6 70.6 19.2 74.6',
    'M 30.8 62.2 C 30.9 66.6 30.6 70.4 30 74',
    'M -23.4 84.6 C -21 82.8 -18.2 83.2 -16.4 85.6' // thumb crease
  ],
  faint: ['M 1 80 C 0.4 100 -0.4 118 -1.4 134', 'M 19 80 C 18.2 100 17 118 15.6 134', 'M 30 80 C 29.8 98 29 116 27.8 132']
}

const knuckle: HandArt = {
  outline: [
    'M -18 150',
    'C -20 134 -24 118 -27.5 102',
    'C -30.6 86 -30.4 70 -26.6 58', // thumb along the side
    'C -24.8 50 -24 44 -23.6 38',
    'C -23.8 22 -20.6 8.4 -13 4.2', // index knuckle
    'C -9 2 -6 2 -4.5 2.6',
    'C -3 0.2 3 -0.4 5.5 1.8', // middle knuckle: the contact
    'C 8 3.5 9.5 4 11 4.6',
    'C 15 3.8 19 5.2 21 8.6', // ring
    'C 23 9.2 25 10 26.5 11.6',
    'C 30.4 12.2 32.8 16 32.8 22', // little finger
    'C 34 40 33 62 30.6 84',
    'C 29 104 27.6 124 27 150'
  ].join(' '),
  details: [
    'M -4.5 3 C -5.4 11 -5.8 18 -5.8 26',
    'M 10.6 5.2 C 10 12.4 9.6 19 9.4 26',
    'M 25.6 11.4 C 24.6 17.6 24 23 23.6 28.6',
    'M -23 33.4 C -10 36.8 12 36.4 31.6 32.6',
    'M -23.6 40 C -20.2 51 -18.8 62 -19.6 74',
    'M -26 88 C -23.6 86.4 -20.8 86.8 -19 89'
  ],
  faint: ['M 0 44 C -1 70 -2 96 -3 122', 'M 14 44 C 13.6 70 13 96 12 122']
}

const flat: HandArt = {
  outline: [
    'M -12 158',
    'C -14 140 -19 124 -26 110',
    'C -32 98 -38 84 -37.6 74',
    'C -37.2 67 -31.6 64 -27.4 67.6', // thumb tip
    'C -23.4 71 -20.2 75.6 -17.6 79',
    'L -17.4 13',
    'C -17.4 7.5 -14.5 4.5 -11.5 4.5', // index tip
    'C -8.6 4.5 -6.2 7 -6.1 9.5',
    'C -6 3.5 -3 -0.6 1 -0.6', // middle tip
    'C 5 -0.6 7.4 3 7.5 7',
    'C 8 3.4 10.8 2.2 13 2.2', // ring tip
    'C 16 2.2 18.2 5 18.3 9',
    'C 19.6 8 22.4 8.2 24.2 10',
    'C 26.8 12.4 27.8 16 27.8 20.5', // little finger tip
    'L 28 68',
    'C 28.6 88 27 110 23.6 128',
    'C 22 138 21 148 20.6 158'
  ].join(' '),
  details: [
    'M -6.1 9.5 C -6 26 -6 44 -6.4 62',
    'M 7.5 7 C 7.6 25 7.6 43 7.3 62',
    'M 18.3 9 C 18.6 26 18.6 44 18.4 64',
    'M -15.5 11 C -13 9.4 -10 9.4 -8 11',
    'M -2.8 5.6 C -0.4 4 2.4 4 4.8 5.6',
    'M 9.8 7.6 C 11.8 6.3 14.2 6.3 16.2 7.6',
    'M 20.8 13.4 C 22.4 12.4 24.2 12.4 25.8 13.6',
    'M -17 70 C -4 74 14 74 27.6 70',
    'M -29.6 74.6 C -27.4 73.2 -25 73.8 -23.4 76'
  ],
  faint: ['M -9 84 C -9.5 102 -10 120 -10 138', 'M 4 84 C 4 104 3.5 122 3 140', 'M 16 84 C 16 102 15 120 14 138']
}

function pinchArt(open: number): HandArt {
  // In profile, pointing +x: index above, thumb below, tips meeting at the origin. `open` (0..1) parts them.
  const o = open
  const iy = -o * 8 // index tip lift
  const ty = o * 6 // thumb tip drop
  return {
    outline: [
      'M -140 -6',
      'C -116 -14 -94 -24 -72 -27', // back of the hand, up to the index knuckle
      `C -52 -31 -26 ${-31 + iy * 0.5} -12 ${-19 + iy}`, // the index arches over
      `C -5 ${-12 + iy} 0.6 ${-6 + iy} 0.8 ${-2 + iy}`, // index tip
      `C 1 ${0.4 + iy} -1.2 ${1.2 + iy} -3.2 ${0.4 + iy}`,
      `C -8 ${-8 + iy * 0.8} -20 ${-17 + iy * 0.5} -32 -16`, // under the index: top of the loop
      'C -43 -15 -50 -6 -48 3', // back of the loop, the web
      `C -44 ${10 + ty * 0.3} -28 ${11 + ty * 0.6} -14 ${7 + ty * 0.9}`, // top of the thumb: bottom of the loop
      `C -8 ${5 + ty} -3 ${2.4 + ty} -1 ${2.6 + ty}`, // thumb tip
      `C 2 ${3.6 + ty} 1.4 ${8.4 + ty} -3 ${9.6 + ty}`,
      `C -16 ${13 + ty * 0.6} -32 20 -48 26`, // under the thumb
      'C -68 34 -90 38 -110 37', // heel of the palm
      'C -122 36 -132 34 -140 32'
    ].join(' '),
    details: [
      `M -7 ${-15 + iy} C -3.6 ${-12 + iy} -2 ${-9 + iy} -1.8 ${-5.6 + iy}`, // nail
      'M -72 -27 C -70 -20 -70 -14 -72 -8', // index knuckle
      'M -56 -10 C -58 -2 -64 6 -72 9', // curled fingers behind
      'M -72 -6 C -76 2 -82 8 -90 11',
      `M -24 ${12 + ty * 0.6} C -20 ${14 + ty * 0.7} -18.4 ${16.6 + ty * 0.8} -18.4 ${19 + ty * 0.9}` // thumb joint
    ],
    faint: ['M -128 6 C -112 4 -96 2 -80 2']
  }
}

// A flat hand in profile, palm down, fingertips at the origin pointing +x (toward the screen).
const side: HandArt = {
  outline: [
    'M -150 -14',
    'C -120 -17 -90 -19 -66 -17', // back of the hand
    'C -54 -16 -44 -13 -38 -10', // knuckle
    'C -26 -8 -12 -6 -4 -5', // top of the fingers
    'C 1 -4.5 3 -1.5 2 1.5', // fingertip
    'C 1 4 -2 5 -6 5',
    'C -20 5.5 -34 6 -44 7', // underside of the fingers
    'C -52 12 -60 18 -72 19', // thumb, tucked under
    'C -82 20 -90 16 -96 13',
    'C -114 12 -132 12 -150 13'
  ].join(' '),
  details: ['M -4 -4 C -1.5 -2.5 -1 0 -2.5 1.5', 'M -38 -10 C -37 -6 -37 -2 -39 2', 'M -44 7 C -54 8 -64 10 -72 13'],
  faint: ['M -130 -6 C -110 -8 -90 -9 -70 -9']
}

export const HANDS: Record<Pose, HandArt> = {
  point,
  knuckle,
  flat,
  pinch: pinchArt(0),
  pinchOpen: pinchArt(1),
  side
}
