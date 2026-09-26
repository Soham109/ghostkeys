import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { World } from "./three/World";
import { filmState, FILM_TAPS } from "./director";
import { S } from "./timeline";
import { C } from "./theme";
import { Grain } from "./components/Atmos";
import { TapLabels } from "./components/Labels";
import { ColdOpenOverlay } from "./overlays/ColdOpen";
import { HeadlineAt, TypeLight, CutFlash } from "./overlays/Type";
import { XrayOverlay } from "./overlays/Xray";
import { ZonesOverlay } from "./overlays/Zones";
import { Features } from "./overlays/Features";
import { EndCard } from "./overlays/EndCard";
import { Chrome } from "./overlays/Chrome";

const cam = (f: number) => filmState(f).cam;
const HERO_TAPS = FILM_TAPS.map((t) => ({ ...t, f: t.f - S.hero }));

export const Promo: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <Sequence from={0} durationInFrames={S.features} layout="none">
      <World state={filmState} taps={FILM_TAPS} />
    </Sequence>
    <Sequence from={S.hero} durationInFrames={S.end - S.hero} layout="none">
      <World state={(f) => filmState(f + S.hero)} taps={HERO_TAPS} particleCount={16} />
    </Sequence>

    {/* 01 cold open */}
    <Sequence from={0} durationInFrames={S.headline} layout="none">
      <ColdOpenOverlay cam={cam} />
    </Sequence>

    {/* 02 premise */}
    <TypeLight from={S.headline} to={S.macro} x="22%" y="52%" />
    <HeadlineAt lines={["Your *laptop* has", "more *buttons*", "than you *think.*"]} start={S.headline + 6} exitAt={S.macro - 22} top={290} size={132} />

    {/* 03 surfaces */}
    <TapLabels taps={FILM_TAPS} cam={cam} from={S.macro} to={S.xray} />
    <TypeLight from={S.heroType} to={S.xray + 4} x="20%" y="62%" />
    <HeadlineAt
      lines={["Every blank *surface*", "is a *key.*"]}
      start={S.heroType + 10}
      exitAt={S.xray - 20}
      top={520}
      size={116}
      kicker="Palm rests · Grilles · Top strip · Edges · Lid"
    />

    {/* 04 sensor */}
    <XrayOverlay cam={cam} start={S.xray} end={S.zones} tapFrames={FILM_TAPS.filter((t) => t.f >= S.xray && t.f < S.zones).map((t) => t.f)} />

    {/* 05 zones */}
    <ZonesOverlay cam={cam} start={S.zones} end={S.features} />

    {/* 06 system */}
    <Features start={S.features} end={S.hero} />

    {/* 07 hero + end */}
    <Sequence from={S.hero} durationInFrames={S.end - S.hero} layout="none">
      <TapLabels taps={HERO_TAPS} cam={(f) => filmState(f + S.hero).cam} from={0} to={999} />
    </Sequence>
    <EndCard start={S.end} />

    <Chrome taps={FILM_TAPS} hideBefore={S.headline} hideAfter={S.end} />
    <CutFlash cuts={[360, 420, 480, 540, 600, 660, 1200, 1860]} />
    <Grain opacity={0.045} />
    <Audio src={staticFile("sfx-film.wav")} />
  </AbsoluteFill>
);
