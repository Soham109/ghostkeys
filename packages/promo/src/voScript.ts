// Voiceover script. Every line starts on a beat (multiple of 15 frames) and sits between hits, never on one. 76 words, no dashes.
export const VO_LINES: Array<{ f: number; text: string }> = [
  { f: 45, text: "Your MacBook already feels every touch." },
  { f: 180, text: "Ghostkeys listens." },
  { f: 330, text: "Tap the palm rest." },
  { f: 480, text: "Knock the grille." },
  { f: 540, text: "Every blank surface becomes a key." },
  { f: 645, text: "Eight hundred readings a second, from the motion sensor inside." },
  { f: 795, text: "A few minutes of calibration, and it learns your hands." },
  { f: 900, text: "Cover the sensor." },
  { f: 960, text: "Nudge the lid." },
  { f: 1005, text: "Pinch the air." },
  { f: 1200, text: "Hover to set the volume." },
  { f: 1275, text: "Watch every touch land, live." },
  { f: 1455, text: "Nothing leaves your Mac." },
  { f: 1560, text: "Just the Mac you already own." },
  { f: 1860, text: "Ghostkeys. Your MacBook has hidden keys." },
];
export const VO_MODEL = "eleven_multilingual_v2";
export const VO_SETTINGS = { stability: 0.45, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true, speed: 0.92 };
// Chosen from three line-1 samples (Eric, Brian, Sarah): steadiest level, warmest spectrum, least sibilance.
export const VO_VOICE = { id: "cjVigY5qzO86Huf0OWal", name: "Eric (Smooth, Trustworthy)" };
