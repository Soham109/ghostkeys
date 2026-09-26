import { Config } from "@remotion/cli/config";

// ANGLE gives the headless Chromium a real GPU-backed WebGL context for the 3D scenes.
Config.setChromiumOpenGlRenderer("angle");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setCodec("h264");
Config.setCrf(16);
Config.setPixelFormat("yuv420p");
Config.setConcurrency(4);
