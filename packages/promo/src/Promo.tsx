import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { World } from "./three/World";
import { filmState, FILM_TAPS } from "./director";
import { S } from "./timeline";
import { C } from "./theme";
import { Grain } from "./components/Atmos";
import { ColdOpenOverlay } from "./overlays/ColdOpen";
import { HeadlineAt, TypeLight, CutFlash } from "./overlays/Type";
import { XrayOverlay } from "./overlays/Xray";
import { CalibNumbers } from "./overlays/CalibNumbers";
import { LivePanel, SplitRule, AppFlat } from "./overlays/AppPanels";
import { TypeMoment } from "./overlays/TypeMoment";
import { EndCard } from "./overlays/EndCard";
import { Captions } from "./overlays/Captions";

const cam = (f: number) => filmState(f).cam;
const shift = (from: number) => FILM_TAPS.map((t) => ({ ...t, f: t.f - from }));

/** v2 film. `vo` picks the mixed voiceover track or the sound design alone. */
export const Promo: React.FC<{ vo: boolean }> = ({ vo }) => (
  <AbsoluteFill style={{ background: C.bg }}>
    {/* 3D, split into sequences so nothing renders under the flat sections */}
    <Sequence from={0} durationInFrames={S.split} layout="none">
      <World state={filmState} taps={FILM_TAPS} />
    </Sequence>
    <Sequence from={S.split} durationInFrames={S.grille - S.split} layout="none">
      <World state={(f) => filmState(f + S.split)} taps={shift(S.split)} particleCount={16} width={960} height={1080} />
    </Sequence>
    <Sequence from={S.grille} durationInFrames={S.appCut - S.grille} layout="none">
      <World state={(f) => filmState(f + S.grille)} taps={shift(S.grille)} particleCount={16} />
    </Sequence>
    <Sequence from={S.hero} durationInFrames={S.end - S.hero} layout="none">
      <World state={(f) => filmState(f + S.hero)} taps={shift(S.hero)} particleCount={16} />
    </Sequence>

    {/* 01, 02 */}
    <Sequence from={0} durationInFrames={S.macro} layout="none">
      <ColdOpenOverlay cam={cam} k={S.matter / 165} />
    </Sequence>
    <TypeLight from={186} to={S.macro} x="18%" y="78%" />
    <HeadlineAt lines={["Hidden", "*keys.*"]} start={190} exitAt={S.macro - 16} left={120} bottom={140} size={230} />

    {/* 04 split */}
    <Sequence from={S.split} durationInFrames={S.grille - S.split} layout="none">
      <LivePanel x={961} w={959} h={1080} taps={[419 - S.split, 463 - S.split]} start={0} />
      <SplitRule x={960} start={0} end={S.grille - S.split} />
    </Sequence>

    {/* 06, 07 */}
    <XrayOverlay cam={cam} start={S.xray} end={S.calib} tapFrames={FILM_TAPS.filter((t) => t.f >= S.xray && t.f < S.calib).map((t) => t.f)} />
    <CalibNumbers cam={cam} start={S.calib} end={S.cover} />

    {/* 10 */}
    <AppFlat start={S.appCut} cut={S.appCut + 30} end={S.type} />

    {/* 11 */}
    <TypeMoment start={S.type} cut={S.typeCut} end={S.hero} />

    {/* end */}
    <EndCard start={S.end} />

    <Captions until={S.end} />
    <CutFlash cuts={[S.macro, S.split, S.grille, S.calib, S.cover, S.lid, S.air, S.sonar, S.app, S.appCut + 30, S.hero]} />
    <Grain opacity={0.045} />
    <Audio src={staticFile(vo ? "mix-film-vo.wav" : "sfx-film.wav")} />
  </AbsoluteFill>
);
