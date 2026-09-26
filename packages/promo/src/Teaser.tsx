import React from "react";
import { AbsoluteFill, Audio, staticFile } from "remotion";
import { World } from "./three/World";
import { teaserState, TEASER_TAPS_ALL, TEASER_K } from "./director";
import { TEASER_END } from "./timeline";
import { C } from "./theme";
import { Grain } from "./components/Atmos";
import { TapLabels } from "./components/Labels";
import { ColdOpenOverlay } from "./overlays/ColdOpen";
import { HeadlineAt, CutFlash } from "./overlays/Type";
import { EndCard } from "./overlays/EndCard";

const cam = (f: number) => teaserState(f).cam;

export const Teaser: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <World state={teaserState} taps={TEASER_TAPS_ALL} />
    <ColdOpenOverlay cam={cam} k={TEASER_K} vertical />
    <HeadlineAt lines={["Your *laptop*", "has more", "*buttons* than", "you think."]} start={122} exitAt={184} left={72} top={170} size={112} />
    <TapLabels taps={TEASER_TAPS_ALL} cam={cam} from={120} to={TEASER_END} scale={1.25} />
    <EndCard start={TEASER_END} vertical speed={1.7} />
    <CutFlash cuts={[160, 190, 220]} />
    <Grain opacity={0.045} />
    <Audio src={staticFile("sfx-teaser.wav")} />
  </AbsoluteFill>
);
