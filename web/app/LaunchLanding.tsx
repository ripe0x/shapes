"use client";

import React from "react";
import Image from "next/image";
import Link from "next/link";
import { DENOMINATIONS as RENDER_DENOMINATIONS } from "@shared/canonical/denominations";
import { renderSampledShape, sampleCompose, type SampleBurn } from "@shared/canonical/sampling";
import { localArt, sampleSeed } from "@shared/site/art";
import { mintGene } from "@shared/previewGene";

const LAUNCH_AT = new Date("2026-09-03T12:00:00-04:00").getTime();

const TIERS = [
  { value: "0.01", grid: "5 × 5", marks: 25 },
  { value: "0.05", grid: "4 × 5", marks: 20 },
  { value: "0.1", grid: "4 × 4", marks: 16 },
  { value: "0.5", grid: "3 × 4", marks: 12 },
  { value: "1", grid: "3 × 3", marks: 9 },
  { value: "5", grid: "2 × 3", marks: 6 },
  { value: "10", grid: "2 × 2", marks: 4 },
  { value: "50", grid: "1 × 2", marks: 2 },
  { value: "100", grid: "1 × 1", marks: 1 },
] as const;

type ProvenanceCard = {
  key: string;
  value: string;
  image: string;
};

type BuiltShape = ProvenanceCard & {
  seed: bigint;
  gene: number;
  modules?: Uint8Array;
};

type ProvenanceExample = {
  root: ProvenanceCard;
  branches: { card: ProvenanceCard; origins: ProvenanceCard[] }[];
};

/** A deterministic, protocol-accurate three-generation provenance tree: ten 0.01 ETH origins
 *  form two 0.05 ETH parents, which are then composed into the surviving 0.1 ETH Shape. */
function buildProvenanceExample(): ProvenanceExample {
  const dataUri = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;
  let nextTokenId = 100n;

  const origin = (seedNumber: number, key: string): BuiltShape => {
    const seed = sampleSeed(seedNumber);
    const gene = mintGene(seed, RENDER_DENOMINATIONS[0]);
    return {
      key,
      value: "0.01",
      image: localArt(seed, RENDER_DENOMINATIONS[0], gene),
      seed,
      gene,
    };
  };

  const makeBranch = (seedBase: number, key: string): { shape: BuiltShape; origins: BuiltShape[] } => {
    const origins = Array.from({ length: 5 }, (_, index) => origin(seedBase + index * 37, `${key}-${index}`));
    const survivor = origins[0];
    const burns: SampleBurn[] = origins.slice(1).map((shape) => ({
      tokenId: nextTokenId++,
      seed: shape.seed,
      denomIndex: 0,
      inkGene: shape.gene,
    }));
    const modules = sampleCompose(
      { seed: survivor.seed, denomIndex: 0, inkGene: survivor.gene },
      burns,
      1,
    );
    return {
      origins,
      shape: {
        key,
        value: "0.05",
        image: dataUri(renderSampledShape(modules, 1, 1n, survivor.gene)),
        seed: survivor.seed,
        gene: survivor.gene,
        modules,
      },
    };
  };

  const left = makeBranch(8_120, "left");
  const right = makeBranch(8_900, "right");
  const rootModules = sampleCompose(
    {
      seed: left.shape.seed,
      denomIndex: 1,
      inkGene: left.shape.gene,
      modules: left.shape.modules,
    },
    [{
      tokenId: nextTokenId++,
      seed: right.shape.seed,
      denomIndex: 1,
      inkGene: right.shape.gene,
      modules: right.shape.modules,
    }],
    2,
  );

  return {
    root: {
      key: "root",
      value: "0.1",
      image: dataUri(renderSampledShape(rootModules, 2, 1n, left.shape.gene)),
    },
    branches: [left, right].map((branch) => ({ card: branch.shape, origins: branch.origins })),
  };
}

const PROVENANCE_EXAMPLE = buildProvenanceExample();

function ProvenanceCardView({ card, className }: { card: ProvenanceCard; className: string }) {
  return (
    <div className={`provenance-card ${className}`}>
      <Image src={card.image} alt={`${card.value} ETH Shape`} width={250} height={350} unoptimized />
      <span>{card.value} ETH</span>
    </div>
  );
}

function TierCard({ tier, index }: { tier: (typeof TIERS)[number]; index: number }) {
  const [hovered, setHovered] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const [hoverBase, setHoverBase] = React.useState(0);
  const timer = React.useRef<number | null>(null);

  const stop = React.useCallback(() => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setHovered(false);
    setTick(0);
  }, []);

  const start = () => {
    if (timer.current) window.clearInterval(timer.current);
    setHoverBase(1 + Math.floor(Math.random() * 4_096));
    setHovered(true);
    setTick(0);
    timer.current = window.setInterval(() => setTick((current) => current + 1), 300);
  };

  React.useEffect(() => stop, [stop]);

  const frame = hovered ? hoverBase + tick : 0;
  const seed = sampleSeed(12_000 + index * 127 + frame * 613);
  // Geometry is tier-indexed and identical on both ladders. Use the active build's amount so
  // hybrid Sepolia builds can render the landing page's mainnet-labeled examples safely.
  const denomination = RENDER_DENOMINATIONS[index];
  const image = localArt(seed, denomination, mintGene(seed, denomination));

  return (
    <article className="tier" onMouseEnter={start} onMouseLeave={stop}>
      <div className="tier-value">
        <strong>{tier.value}</strong>
        <span>ETH</span>
      </div>
      <Image
        className="tier-art"
        src={image}
        alt={`Example ${tier.value} ETH Shape`}
        width={250}
        height={350}
        unoptimized
      />
      <div className="tier-cost">
        <span>{tier.grid} grid</span>
        <strong>{tier.marks} {tier.marks === 1 ? "mark" : "marks"}</strong>
      </div>
    </article>
  );
}

function useCountdown() {
  const [remaining, setRemaining] = React.useState<number | null>(null);

  React.useEffect(() => {
    const update = () => setRemaining(Math.max(0, LAUNCH_AT - Date.now()));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = Math.floor((remaining ?? 0) / 1000);
  return {
    ready: remaining !== null,
    live: remaining === 0,
    days: Math.floor(seconds / 86_400),
    hours: Math.floor((seconds % 86_400) / 3_600),
    minutes: Math.floor((seconds % 3_600) / 60),
    seconds: seconds % 60,
  };
}

function Countdown() {
  const countdown = useCountdown();
  const units = [
    [countdown.days, "days"],
    [countdown.hours, "hours"],
    [countdown.minutes, "minutes"],
    [countdown.seconds, "seconds"],
  ] as const;

  return (
    <section className="launch-countdown" aria-labelledby="mint-time">
      <div>
        <p className="launch-kicker">Public mint</p>
        <h2 id="mint-time">
          {countdown.live ? "Minting is live." : "September 3, 12:00 PM ET"}
        </h2>
      </div>

      {!countdown.live ? (
        <div className="countdown-units" aria-live="polite" aria-label="Time until mint">
          {units.map(([value, label]) => (
            <div className="countdown-unit" key={label}>
              <span>{countdown.ready ? String(value).padStart(2, "0") : "--"}</span>
              <small>{label}</small>
            </div>
          ))}
        </div>
      ) : (
        <Link className="launch-button" href="/mint">
          Mint a Shape
        </Link>
      )}
    </section>
  );
}

export function LaunchLanding() {
  return (
    <main className="launch-page">
      {/* No header: the hero title is the wordmark. The play link keeps the header's slot. */}
      <nav className="launch-play-link" aria-label="Primary navigation">
        <Link href="/play">Play</Link>
      </nav>

      <section className="launch-hero" id="top">
        <div className="launch-intro">
          <h1>Shapes</h1>
          <p className="launch-subhead">
            Each Shape holds an exact amount of ETH. That value determines its appearance, and
            the holder can destroy the Shape at any time to get the ETH back.
          </p>
        </div>

        <figure className="launch-art">
          <Image
            src="/contract-animation.svg"
            alt="Animated Shapes collection artwork moving from dense grids to a single mark"
            width={3840}
            height={3840}
            priority
            unoptimized
          />
          <figcaption>18 onchain compositions, moving through all nine value tiers.</figcaption>
        </figure>
      </section>

      <Countdown />

      <section className="launch-section launch-about" aria-labelledby="about-title">
        <div>
          <p className="launch-kicker">The project</p>
          <h2 id="about-title">ETH in, Shape out. Shape burned, ETH returned.</h2>
        </div>
        <div className="launch-prose">
          <p>
            A Shape is a generative ERC-721 backed by one of nine fixed amounts of ETH. Its value
            is readable onchain, so it can be collected, transferred, traded, or used by another
            contract while remaining exactly redeemable.
          </p>
          <p>
            Higher value produces fewer marks. A 0.01 ETH Shape fills a 5 × 5 grid. A 100 ETH
            Shape is one mark on a field. The artwork and metadata are generated entirely onchain.
          </p>
        </div>
      </section>

      <section className="launch-section launch-tiers" id="tiers" aria-labelledby="tiers-title">
        <div className="launch-section-heading">
          <div>
            <p className="launch-kicker">Nine fixed tiers</p>
            <h2 id="tiers-title">Mainnet value tiers</h2>
          </div>
          <p>
            Each value is exact and fully redeemable. A flat 0.001 ETH fee is added once when
            minting.
          </p>
        </div>

        <div className="tier-grid">
          {TIERS.map((tier, index) => (
            <TierCard tier={tier} index={index} key={tier.value} />
          ))}
        </div>
      </section>

      <section className="launch-section launch-mechanics" id="lineage" aria-labelledby="mechanics-title">
        <div className="mechanics-copy">
          <p className="launch-kicker">How it works</p>
          <h2 id="mechanics-title">Value with a visible history.</h2>
          <div className="mechanic-grid">
            <article>
              <span>01</span>
              <h3>Mint</h3>
              <p>
                Choose a tier and send its backing plus the 0.001 ETH mint fee. The Shape is
                generated onchain.
              </p>
            </article>
            <article>
              <span>02</span>
              <h3>Compose</h3>
              <p>Compatible Shapes can become a higher-value Shape. Their ETH and history move into the survivor.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Redeem</h3>
              <p>Burn a Shape to receive its exact backing. There is no redemption fee.</p>
            </article>
          </div>
        </div>
        <div className="mechanics-detail">
          <figure className="provenance-chart">
            <div
              className="provenance-tree"
              role="img"
              aria-label="A 0.1 ETH Shape built from two 0.05 ETH Shapes, each built from five 0.01 ETH Shapes"
            >
              <ProvenanceCardView card={PROVENANCE_EXAMPLE.root} className="provenance-root" />
              <div className="provenance-root-stem" />
              <div className="provenance-branches">
                {PROVENANCE_EXAMPLE.branches.map((branch) => (
                  <div className="provenance-branch" key={branch.card.key}>
                    <ProvenanceCardView card={branch.card} className="provenance-parent" />
                    <div className="provenance-parent-stem" />
                    <div className="provenance-origins">
                      {branch.origins.map((origin) => (
                        <div className="provenance-origin" key={origin.key}>
                          <ProvenanceCardView card={origin} className="provenance-leaf" />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="provenance-summary">10 recorded origins · 0.01 ETH each</div>
            </div>
            <figcaption>
              <span>Example provenance</span>
              <p>
                Every Shape this one was built from. Burned Shapes can still be drawn from their
                recorded seeds.
              </p>
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="launch-faq" id="faq" aria-labelledby="faq-title">
        <div className="faq-heading">
          <p className="launch-kicker">Practical details</p>
          <h2 id="faq-title">Before minting</h2>
        </div>
        <div className="faq-list">
          <article>
            <h3>Where does the ETH go?</h3>
            <p>The contract holds it until redemption. It does not lend, stake, or invest it.</p>
          </article>
          <article>
            <h3>How does redemption work?</h3>
            <p>The current holder burns the Shape and receives its exact backing. There is no redemption fee.</p>
          </article>
          <article>
            <h3>What does minting cost?</h3>
            <p>
              The selected backing plus a one-time 0.001 ETH fee. A 1 ETH Shape costs 1.001 ETH to
              mint.
            </p>
          </article>
          <article>
            <h3>What is stored onchain?</h3>
            <p>The value, artwork, metadata, and composition history. No external image host is required.</p>
          </article>
        </div>
      </section>

      <footer className="launch-footer">
        <span>
          An Ethereum primitive by{" "}
          <a href="https://x.com/ripe0x" target="_blank" rel="noreferrer">
            ripe
          </a>
        </span>
        <a href="#top">Back to top</a>
      </footer>
    </main>
  );
}
